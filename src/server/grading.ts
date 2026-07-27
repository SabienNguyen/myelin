import { convertLatexToAsciiMath } from 'mathlive';
import { create, all } from 'mathjs';
import { generateText, Output } from 'ai';
import { annotationSchema, type BlockToolName, type WritingAnnotations } from '../shared/blocks.js';
import type { EvidenceKind } from '../shared/loreweaver.js';
import { claudeSdkGenerate, isClaudeSdkModel, stripClaudeSdkPrefix } from './claudeSdk.js';
import { modelFor } from './models.js';
import type { HarnessConfig } from './config.js';

/** Injectable seam for tests — see claudeSdk.ts. Real callers omit this; it defaults to the
 * real Agent SDK call. */
export interface GradingDeps {
  sdkGenerate?: typeof claudeSdkGenerate;
}

// predictable: true makes functions like log()/sqrt() return NaN (not a Complex) outside
// their real domain, so the NaN-equality short-circuit below actually fires — without it,
// e.g. ln(x) at negative samples returns a Complex object and `ra - rb` silently yields NaN
// for BOTH equal and unequal expressions, breaking the ln test.
const math = create(all, { predictable: true });
const SAMPLES = [-2.3, -1, -0.5, 0.7, 1.1, 2, 3.7];

// AsciiMath spellings that mathjs cannot parse. `\div` — an ordinary division sign, present on
// MathLive's own keypad — converts to AsciiMath's `-:`, which threw in math.compile and made
// mathEquivalent return false, i.e. graded a CORRECT answer wrong. Found while generalising this
// function; elementary arithmetic is exactly the kind of thing a learn-anything tutor must not fail.
const ASCIIMATH_FIXUPS: readonly [RegExp, string][] = [
  [/\s-:\s?/g, '/'],   // \div
  [/\bxx\b/g, '*'],    // \times spelled as AsciiMath xx
];

function normalizeAsciiMath(latex: string): string {
  let s = convertLatexToAsciiMath(latex);
  for (const [re, to] of ASCIIMATH_FIXUPS) s = s.replace(re, to);
  return s
    .replace(/\bln\s*\(/g, 'log(')
    .replace(/\)\s*(?=[A-Za-z0-9(])/g, ')*'); // fixes (1)/(2)x binding to 1/(2x)
}

function latexToCompiled(latex: string) {
  return math.compile(normalizeAsciiMath(latex));
}

/** Free variables actually referenced by a LaTeX expression. mathjs parses to an AST whose
 * SymbolNodes are either variables or function names; a symbol used as a call target
 * (`sin(x)`) is a FunctionNode's fn, so filtering on `isSymbolNode` alone would wrongly collect
 * `sin`. Constants mathjs defines itself (pi, e, i, …) are excluded by checking the default scope.
 * Returns [] rather than throwing on unparseable input — callers already treat that as not-equal. */
export function freeVariables(latex: string): string[] {
  try {
    const node = math.parse(normalizeAsciiMath(latex));
    const found = new Set<string>();
    node.traverse((n: any, _path: string, parent: any) => {
      if (n.type !== 'SymbolNode') return;
      if (parent?.type === 'FunctionNode' && parent.fn === n) return; // function name, not a variable
      if ((math as any)[n.name] !== undefined) return;                // pi, e, i, …
      found.add(n.name);
    });
    return [...found].sort();
  } catch { return []; }
}

/**
 * Numeric-equivalence check by sampling. Multivariate as of the learn-anything pass: single-variable
 * maths was the only kind this could grade, which capped applied evidence for physics, statistics,
 * engineering, and finance.
 *
 * `vars` is now optional — the variables are DETECTED from both expressions and unioned with
 * whatever the caller declared, so a tutor writing `V = nRT/P` does not have to enumerate four
 * names for it to be gradeable. A declared name that appears in neither expression is harmless.
 *
 * SAMPLING IS DECORRELATED, which is the whole correctness question in more than one dimension:
 * assigning every variable the same value per point would make `x + y` and `2x` agree on every
 * sample and grade a wrong answer correct. Each variable therefore walks SAMPLES with its own
 * stride and offset (derived from its index, so it stays deterministic and reproducible — no RNG),
 * and the point count is raised to cover the larger space.
 */
export function mathEquivalent(
  a: string, b: string, vars?: string | string[], eps = 1e-9,
): boolean {
  try {
    const fa = latexToCompiled(a), fb = latexToCompiled(b);
    const declared = vars === undefined ? [] : (Array.isArray(vars) ? vars : [vars]);
    const detected = [...new Set([...freeVariables(a), ...freeVariables(b)])];
    // Fall back to 'x' so a caller passing nothing against a constant-only pair still samples once.
    const names = [...new Set([...declared, ...detected])];
    if (names.length === 0) names.push('x');

    const points = names.length === 1 ? SAMPLES.length : SAMPLES.length * 3;
    for (let k = 0; k < points; k++) {
      const scope: Record<string, number> = {};
      names.forEach((name, i) => {
        // Stride 2i+1 is coprime-ish with SAMPLES.length (7) for small i, so variables sweep the
        // sample set out of phase with each other instead of moving together.
        scope[name] = SAMPLES[(k * (2 * i + 1) + i * 3) % SAMPLES.length];
      });
      let ra: number, rb: number;
      try { ra = fa.evaluate(scope); rb = fb.evaluate(scope); } catch { continue; }
      if (typeof ra !== 'number' || typeof rb !== 'number') continue; // matrices/units — not sampled
      if (Number.isNaN(ra) && Number.isNaN(rb)) continue;
      if (Math.abs(ra - rb) > eps * Math.max(1, Math.abs(ra), Math.abs(rb))) return false;
    }
    return true;
  } catch { return false; }
}

import { gradeChemEquation, gradeNotes, gradeUnitAnswer } from './structuredCheckers.js';
import { z } from 'zod';

// ── structured_check: mechanical checkers ──────────────────────────────────────────────────────
// Every branch is arithmetic or string comparison. Nothing here calls a model, so the resulting
// applied-correctly evidence rests on a machine decision rather than a model's opinion — the
// property that makes this block safe to use in subjects nobody hand-authored content for.

/** Case/whitespace-insensitive comparison key. Also folds internal runs of whitespace, so
 *  "sodium  chloride" and "Sodium chloride" match, and strips surrounding quotes a learner may add. */
function normKey(s: string): string {
  return s.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').toLowerCase();
}

/** Leading number out of free text, tolerating a trailing unit and thousands separators:
 *  "9.81 m/s^2" -> 9.81, "1,024" -> 1024, "6.02e23" -> 6.02e23. NaN when there is no number. */
export function parseLeadingNumber(s: string): number {
  const m = s.trim().replace(/,(?=\d{3}\b)/g, '').match(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
  return m ? Number(m[0]) : NaN;
}

interface StructuredGrade {
  allCorrect: boolean;
  anyCorrect: boolean;
  detail: string;
  // `source` per item where a block mixes them (quiz): 'model' marks the items a model judged, so
  // the UI can show WHICH answers were checked and which were believed. Absent = mechanical.
  perItem?: { id: string; correct: boolean; source?: GradeSource }[];
}

export function gradeStructured(checker: any, values: string[]): StructuredGrade {
  const clean = values.map((v) => String(v ?? '')).filter((v) => v.trim() !== '');

  if (checker.kind === 'numeric') {
    const got = parseLeadingNumber(clean[0] ?? '');
    if (Number.isNaN(got)) {
      return { allCorrect: false, anyCorrect: false, detail: 'no number found in the answer' };
    }
    // Default tolerance is a hair above float noise rather than 0, so 0.1+0.2 style answers pass.
    const tol = checker.tolerance ?? 1e-9;
    const limit = checker.relative ? Math.abs(checker.expected) * tol : tol;
    const numOk = Math.abs(got - checker.expected) <= limit;
    // Unit is checked only when the question asked for one, and only as a normalised substring —
    // "m/s^2", "m/s2" and "M/S^2" all satisfy a declared "m/s^2".
    const unitOk = !checker.unit
      || normKey(clean[0] ?? '').replace(/[\s^]/g, '').includes(normKey(checker.unit).replace(/[\s^]/g, ''));
    const ok = numOk && unitOk;
    // "value and unit match" only when a unit was actually asked for — the audit caught a unitless
    // numeric check congratulating a unit that never existed, which is a small lie in the one
    // place the app must never lie.
    const detail = numOk
      ? (!checker.unit ? 'correct'
        : unitOk ? 'value and unit match' : `value matches but the unit should be ${checker.unit}`)
      : `expected ${checker.expected}${checker.unit ? ` ${checker.unit}` : ''}`;
    return { allCorrect: ok, anyCorrect: numOk, detail };
  }

  if (checker.kind === 'set') {
    // Multiset comparison so a duplicated answer is not silently accepted as coverage.
    const want = checker.expected.map(normKey);
    const got = clean.map(normKey);
    const remaining = [...want];
    let hits = 0;
    for (const g of got) {
      const i = remaining.indexOf(g);
      if (i >= 0) { remaining.splice(i, 1); hits++; }
    }
    const extras = got.length - hits;
    const allCorrect = hits === want.length && extras === 0;
    return {
      allCorrect,
      anyCorrect: hits > 0,
      detail: `${hits}/${want.length} correct${extras > 0 ? `, ${extras} not on the list` : ''}`,
      perItem: checker.expected.map((e: string, i: number) => ({
        id: `item-${i}`, correct: got.includes(normKey(e)),
      })),
    };
  }

  if (checker.kind === 'sequence') {
    const want = checker.expected.map(normKey);
    const got = clean.map(normKey);
    const perItem = want.map((w: string, i: number) => ({ id: `pos-${i}`, correct: got[i] === w }));
    const hits = perItem.filter((p: any) => p.correct).length;
    return {
      allCorrect: hits === want.length && got.length === want.length,
      anyCorrect: hits > 0,
      detail: `${hits}/${want.length} in the right position`,
      perItem,
    };
  }

  if (checker.kind === 'matching') {
    const perItem = checker.items.map((it: any, i: number) => ({
      id: it.left, correct: normKey(clean[i] ?? '') === normKey(it.right),
    }));
    const hits = perItem.filter((p: any) => p.correct).length;
    return {
      allCorrect: hits === checker.items.length,
      anyCorrect: hits > 0,
      detail: `${hits}/${checker.items.length} matched`,
      perItem,
    };
  }

  if (checker.kind === 'unit') {
    const v = gradeUnitAnswer(clean[0] ?? '', checker);
    return { allCorrect: v.ok, anyCorrect: v.ok, detail: v.detail };
  }

  if (checker.kind === 'chem_equation') {
    const v = gradeChemEquation(clean[0] ?? '', checker);
    return { allCorrect: v.ok, anyCorrect: v.ok, detail: v.detail };
  }

  if (checker.kind === 'notes') {
    // One input, notes separated however the learner separates them — "C E G", "C, E, G".
    const parts = (clean[0] ?? '').split(/[,\s]+/).filter(Boolean);
    const v = gradeNotes(parts, checker);
    return { allCorrect: v.ok, anyCorrect: v.ok, detail: v.detail };
  }

  // pattern
  const ok = normKey(clean[0] ?? '') === normKey(checker.expected);
  return { allCorrect: ok, anyCorrect: ok, detail: ok ? 'exact match' : `expected "${checker.expected}"` };
}

/**
 * WHERE THE VERDICT CAME FROM. This is the single place the distinction is named.
 *
 * 'mechanical' — a real test suite, numeric equivalence, an exact expected value, or one of
 *   gradeStructured's checkers. Nothing here can be argued into agreeing.
 * 'model'      — the grader model judged an open answer or a draft. Useful, and not verification.
 *
 * The rule below is the one that gives `applied-correctly` its meaning, and until this type existed
 * it was not written down anywhere: it held only because six independent branches of
 * gradeBlockOutput happened to agree, and TWO of them did not. `quiz` routed short-answer items
 * through the grader model and then aggregated them into 'applied-correctly'; `writing_draft` is
 * model-graded end to end and minted 'applied-correctly' whenever no skill came back weak. Both
 * claimed mechanical verification for a judgement no mechanism made.
 */
export type GradeSource = 'mechanical' | 'model';

export interface Grade {
  verdict: 'correct' | 'partial' | 'incorrect' | 'reviewed';
  /** How the verdict was reached. Every return site declares it; see capApplied. */
  source: GradeSource;
  detail: string;
  perItem?: { id: string; correct: boolean }[];
  annotations?: WritingAnnotations;
  rubric?: { criterion: string; pass: boolean; note: string }[];
  evidence: { slug: string; kind: EvidenceKind; note: string }[];
}

/**
 * THE RULE: only mechanically-verified work may mint `applied-correctly`.
 *
 * A model-graded pass becomes `explained-correctly` instead — the learner did demonstrate
 * something, and what they demonstrated is that they can articulate it, not that a machine
 * confirmed it. Every other kind passes through untouched: a model is perfectly able to observe
 * that an answer was wrong, so 'struggled' needs no ceiling, and neither does 'exposed'.
 *
 * Same shape as the two ceilings already in this file — the Anki-review ceiling and
 * code_exercise's reveal ceiling. In each case the affordance stays available and the evidence
 * stays honest.
 *
 * Note for whoever changes applyEvidence next: today this cap has NO effect on mastery, because
 * loreweaver's student/model.ts puts 'explained-correctly' and 'applied-correctly' in the same
 * branch — both step exactly one rung. So the two kinds currently differ in truthfulness and
 * nothing else. That is a live design question (should applied work resist decay longer? should
 * explaining alone be unable to reach 'mastered'?) and this is the seam where it would be answered.
 */
export function capApplied(kind: EvidenceKind, source: GradeSource): EvidenceKind {
  if (source === 'model' && kind === 'applied-correctly') return 'explained-correctly';
  return kind;
}

/**
 * The ONLY constructor for an evidence entry, and the only place the cap is applied.
 *
 * `source` is required rather than defaulted, deliberately: a default would let a new block emit
 * evidence without ever deciding how its verdict was reached, which is exactly the omission that
 * let `quiz` and `writing_draft` drift. Routing every site through here also makes the rule
 * structural instead of remembered — before this, capApplied was called at 3 of 8 sites, so
 * over-applying or forgetting it was only partly detectable.
 */
const ev = (slug: string, kind: EvidenceKind, note: string, source: GradeSource) =>
  ({ slug, kind: capApplied(kind, source), note });

export async function gradeBlockOutput(
  tool: BlockToolName, input: any, result: any, cfg: HarnessConfig, deps: GradingDeps = {},
): Promise<Grade> {
  if (tool === 'quick_check') {
    if (input.expected != null) {
      const ok = result.answer.trim().toLowerCase() === input.expected.trim().toLowerCase();
      if (ok) {
        return {
          verdict: 'correct',
          source: 'mechanical',
          detail: 'exact match',
          evidence: [ev(input.pageSlug, 'applied-correctly', `quick_check: ${input.question}`, 'mechanical')],
        };
      }
      // A miss on the EXACT string is not yet a wrong answer — the audit caught "a buffer carried
      // across reads" graded incorrect against expected "buffer". Fall back to the model grader
      // with the expected answer as context: a right-but-rephrased answer earns the model-graded
      // kind (capApplied keeps it from minting applied-correctly — a model judged it, honestly so),
      // and a genuinely wrong one still records struggled. Free-text punishing phrasing teaches
      // learners to guess the grader's wording, which is the opposite of knowing the thing.
      return gradeOpenAnswer(input.question, result.answer, input.pageSlug, cfg, deps, input.expected);
    }
    return gradeOpenAnswer(input.question, result.answer, input.pageSlug, cfg, deps);
  }

  if (tool === 'math_scratchpad') {
    const finalOk = mathEquivalent(
      result.finalLatex, input.expectedLatex,
      // `variables` (multivariate) wins when present; `variable` remains the single-variable path.
      input.variables ?? input.variable,
    );
    const badStep = input.stepMode
      ? result.steps.findIndex((s: { latex: string }) => !latexParses(s.latex)) : -1;
    return {
      verdict: finalOk ? 'correct' : 'incorrect',
      source: 'mechanical',
      detail: finalOk ? 'final answer numerically equivalent'
        : `final differs from expected${badStep >= 0 ? `; step ${badStep + 1} unparseable` : ''}`,
      evidence: [ev(input.pageSlug, finalOk ? 'applied-correctly' : 'struggled',
        `math: ${input.problemLatex} → ${result.finalLatex}`, 'mechanical')],
    };
  }

  if (tool === 'quiz') {
    // A quiz is the one block that mixes both sources: multiple-choice items with an `expected`
    // are exact-matched, short-answer items go to the grader model. The per-ITEM source therefore
    // has to be carried through the aggregation, because evidence is emitted per SLUG and one
    // model-graded item is enough to make that slug's verdict a judgement rather than a check.
    const perItem = await Promise.all(input.items.map(async (item: any) => {
      const answer = result.answers.find((a: any) => a.id === item.id)?.answer ?? '';
      if (item.type !== 'short' && item.expected != null) {
        return {
          id: item.id, source: 'mechanical' as GradeSource,
          correct: answer.trim().toLowerCase() === item.expected.trim().toLowerCase(),
        };
      }
      // Short items follow the quick_check discipline: an exact match on `expected` is
      // mechanically correct and never consults a model — the audit caught a short answer that
      // WAS the expected string verbatim marked ✗ by the judge. Only a miss goes to the model,
      // with `expected` as context so right-but-rephrased still earns credit.
      if (item.expected != null
        && answer.trim().toLowerCase() === item.expected.trim().toLowerCase()) {
        return { id: item.id, source: 'mechanical' as GradeSource, correct: true };
      }
      const g = await gradeOpenAnswer(item.prompt, answer, item.pageSlug, cfg, deps, item.expected ?? undefined);
      return { id: item.id, source: 'model' as GradeSource, correct: g.verdict === 'correct' };
    }));
    const right = perItem.filter((p) => p.correct).length;
    const bySlug = new Map<string, { right: number; total: number; source: GradeSource }>();
    for (const item of input.items) {
      const s = bySlug.get(item.pageSlug) ?? { right: 0, total: 0, source: 'mechanical' as GradeSource };
      const scored = perItem.find((p) => p.id === item.id);
      s.total++; if (scored?.correct) s.right++;
      if (scored?.source === 'model') s.source = 'model';
      bySlug.set(item.pageSlug, s);
    }
    return {
      verdict: right === perItem.length ? 'correct' : right > 0 ? 'partial' : 'incorrect',
      // The block's own source is the weakest of its items: a quiz containing one short answer is
      // not a mechanically-verified quiz, however many multiple-choice items surround it.
      source: [...bySlug.values()].some((s) => s.source === 'model') ? 'model' : 'mechanical',
      detail: `${right}/${perItem.length}`,
      perItem, // sources included — the graded card shows which items were judged vs checked
      evidence: [...bySlug].map(([slug, s]) => ev(
        slug,
        s.right === s.total ? 'applied-correctly' : 'struggled',
        `quiz ${s.right}/${s.total}${s.source === 'model' ? ' (model-graded)' : ''}`,
        s.source,
      )),
    };
  }

  // structured_check — the generic applied block. MECHANICAL throughout: no model is consulted for
  // any checker, which is what lets applied evidence generalise to subjects nobody hand-authored.
  if (tool === 'structured_check') {
    const g = gradeStructured(input.checker, result.values ?? []);
    const kind: EvidenceKind = g.allCorrect ? 'applied-correctly' : 'struggled';
    return {
      verdict: g.allCorrect ? 'correct' : g.anyCorrect ? 'partial' : 'incorrect',
      source: 'mechanical',
      detail: g.detail,
      ...(g.perItem ? { perItem: g.perItem } : {}),
      evidence: [ev(input.pageSlug, kind, `${input.checker.kind} check: ${input.prompt}`, 'mechanical')],
    };
  }

  // label_diagram — region-membership equality. Arithmetic, no model: the block that makes
  // picture-first subjects (anatomy, circuits, voicings) capable of minting applied evidence.
  if (tool === 'label_diagram') {
    const placed = new Map<string, string>(
      (result.placements ?? []).map((p: any) => [String(p.regionId), String(p.label)]),
    );
    const perItem = (input.regions ?? []).map((r: any) => ({
      id: r.id,
      correct: normKey(placed.get(r.id) ?? '') === normKey(r.label),
    }));
    const hits = perItem.filter((p: { correct: boolean }) => p.correct).length;
    const all = hits === perItem.length && perItem.length > 0;
    const kind: EvidenceKind = all ? 'applied-correctly' : 'struggled';
    return {
      verdict: all ? 'correct' : hits > 0 ? 'partial' : 'incorrect',
      source: 'mechanical',
      detail: `${hits}/${perItem.length} regions labelled correctly`,
      perItem,
      evidence: [ev(input.pageSlug, kind, `labelled a diagram: ${input.prompt}`, 'mechanical')],
    };
  }

  if (tool === 'code_exercise') {
    // Sandbox unreachable: record NOTHING. A learner who never got to attempt the exercise has
    // demonstrated neither success nor struggle, and an empty evidence array is what stops the
    // session guardrail nagging the tutor to record something that does not exist.
    if (result.unavailable === true) {
      return {
        verdict: 'reviewed',
        // Mechanical: no model was consulted, and no evidence is emitted either way.
        source: 'mechanical',
        detail: 'exercise unavailable — the coding sandbox did not respond',
        evidence: [],
      };
    }
    // Mechanical (docs/superpowers/plans/2026-07-20-gap-integration.md I2 contract): NEVER calls a
    // model — completed && wroteCode -> 'applied-correctly' (passed real tests with own code);
    // completed && !wroteCode -> 'exposed' (watched/completed guided rungs only, no own code
    // graded); !completed -> 'struggled' (abandoned via the "stop here" affordance).
    // Reveal ceiling: revealing a test's expected value can substitute for understanding the
    // pattern, so a run where the learner did that can reach 'exposed' at best — it can never mint
    // 'applied-correctly', however green the suite ended up. Exactly the Anki-review ceiling
    // applied to a different shortcut: the affordance stays available, the evidence stays honest.
    // 'struggled' is left alone; a reveal is not evidence of struggling.
    const revealed = result.revealedExpected === true;
    const earned: EvidenceKind = !result.completed ? 'struggled'
      : result.wroteCode ? 'applied-correctly' : 'exposed';
    const kind: EvidenceKind = earned === 'applied-correctly' && revealed ? 'exposed' : earned;
    // The failing-case names ride into the evidence note: "stopped at full_body" says the learner
    // gave up; "…still failing: single event split across two chunks; multi-byte UTF-8 character
    // split across chunks" says they can parse whole chunks and cannot buffer across reads — a
    // misconception the tutor can name, probe and record. Capped at three so a wide miss stays a
    // readable note rather than a dump.
    const failing: string[] = Array.isArray(result.failingTests) ? result.failingTests : [];
    const failingNote = failing.length > 0
      ? ` — still failing: ${failing.slice(0, 3).join('; ')}${failing.length > 3 ? ` (+${failing.length - 3} more)` : ''}`
      : '';
    const note = result.completed
      ? (result.wroteCode
        ? (revealed
          ? 'passed real tests with own code, but revealed expected values — capped at exposed'
          : 'passed real tests with own code')
        : `completed ${result.rungReached} (guided)`)
      : `stopped at ${result.rungReached}${failingNote}`;
    // `detail` used to be `${testsPassed}/${testsTotal} tests`, which the graded card ALREADY
    // renders one line above — the same number twice, and no room left to say the thing neither
    // line said: which evidence this run actually minted. That mattered most in the reveal case,
    // where a learner saw a green 5/5 and no indication their evidence had been capped. It also
    // reaches the tutor (session.ts appends every grade's verdict + detail to the thread), so the
    // tutor now knows the ceiling applied rather than inferring a clean pass from "5/5 tests".
    const detail = !result.completed
      ? `recorded as struggled — stopped at ${result.rungReached}${failingNote}`
      : kind === 'applied-correctly'
        ? 'recorded as applied-correctly'
        : revealed
          ? 'recorded as exposed — expected values were revealed, so this cannot count as applying the pattern'
          : 'recorded as exposed — guided rungs only, no code of your own was graded';
    return {
      verdict: result.completed ? 'correct' : 'incorrect',
      // The artifact's real suite ran in the sandbox — the strongest mechanical grade in the app.
      source: 'mechanical',
      detail,
      evidence: [ev(input.pageSlug, kind, note, 'mechanical')],
    };
  }

  // writing_draft with an explicit rubric — the judged-work path for essay subjects. The grader
  // marks each stated criterion pass/fail; passing ALL of them mints 'rubric-passed', the third
  // positive evidence kind (loreweaver caps it at practicing and decays it on its own shorter
  // window). It is deliberately NOT 'applied-correctly' — a rubric is a model applying criteria,
  // and naming it keeps it from ever laundering into the evidence that gates 'mastered'.
  if (Array.isArray(input.rubric) && input.rubric.length > 0) {
    const rubricPrompt = `Judge this draft against each rubric criterion. Prompt: "${input.prompt}"\n`
      + `Draft:\n${result.draft}\n\nCriteria:\n${input.rubric.map((r: string, i: number) => `${i + 1}. ${r}`).join('\n')}\n`
      + 'For each criterion, decide pass or fail and give a one-line note quoting the draft where possible.';
    const rubricSchema = z.object({
      criteria: z.array(z.object({ criterion: z.string(), pass: z.boolean(), note: z.string() })),
    });
    const graderId = cfg.models.grader.model;
    let judged: { criteria: { criterion: string; pass: boolean; note: string }[] };
    if (isClaudeSdkModel(graderId)) {
      const sdkGenerate = deps.sdkGenerate ?? claudeSdkGenerate;
      const { text } = await sdkGenerate({
        model: stripClaudeSdkPrefix(graderId),
        prompt: `${rubricPrompt}\n\nRespond with ONLY valid JSON: {"criteria": [{"criterion": <string>, "pass": <boolean>, "note": <string>}]}`,
        maxTurns: 1,
      });
      judged = JSON.parse(text);
    } else {
      const { output } = await generateText({
        model: modelFor('grader', cfg), prompt: rubricPrompt, output: Output.object({ schema: rubricSchema }),
      });
      judged = output as typeof judged;
    }
    // The MODEL's list is advisory; the RUBRIC's list is authoritative. A grader that returned
    // fewer criteria than were asked must not pass the draft by omission.
    const byName = new Map(judged.criteria.map((c) => [c.criterion.trim().toLowerCase(), c]));
    const results = input.rubric.map((criterion: string) => {
      const found = byName.get(criterion.trim().toLowerCase())
        ?? judged.criteria.find((c) => c.criterion.toLowerCase().includes(criterion.slice(0, 24).toLowerCase()));
      return found ? { criterion, pass: found.pass, note: found.note }
        : { criterion, pass: false, note: 'the grader did not address this criterion' };
    });
    const passed = results.filter((r: { pass: boolean }) => r.pass).length;
    const all = passed === results.length;
    return {
      verdict: 'reviewed', source: 'model',
      detail: `rubric: ${passed}/${results.length} criteria met`,
      rubric: results,
      evidence: [ev(input.pageSlug, all ? 'rubric-passed' : 'struggled',
        `rubric (${passed}/${results.length}): ${input.rubric.join('; ')}`, 'model')],
    };
  }

  // writing_draft — grader role, structured output
  const draftPrompt = `Grade this student draft. Prompt: "${input.prompt}"\nDraft:\n${result.draft}\n`
    + `Return annotations whose "span" values are EXACT substrings of the draft, and per-skill grades for: claim, concision, specificity.`;
  const graderModelId = cfg.models.grader.model;
  let ann: WritingAnnotations;
  if (isClaudeSdkModel(graderModelId)) {
    const sdkGenerate = deps.sdkGenerate ?? claudeSdkGenerate;
    const { text } = await sdkGenerate({
      model: stripClaudeSdkPrefix(graderModelId),
      // The Agent SDK path has no Output.object — ask for JSON-only and parse it ourselves.
      prompt: `${draftPrompt}\n\nRespond with ONLY valid JSON (no markdown fences, no commentary) `
        + 'matching this exact shape: {"annotations": [{"span": <string>, "category": '
        + '<"strong"|"wordy"|"vague"|"structure"|"grammar">, "note": <string>}], "skillGrades": '
        + '{"claim": <"good"|"weak">, "concision": <"good"|"weak">, "specificity": <"good"|"weak">}}',
      maxTurns: 1,
    });
    try {
      ann = JSON.parse(text) as WritingAnnotations;
    } catch (e) {
      throw new Error(`claude-sdk grader returned invalid JSON: ${(e as Error).message}. Raw: ${text.slice(0, 300)}`);
    }
  } else {
    const { output } = await generateText({
      model: modelFor('grader', cfg),
      prompt: draftPrompt,
      output: Output.object({ schema: annotationSchema }),
    });
    ann = output as WritingAnnotations;
  }
  const weak = Object.values(ann.skillGrades).filter((g) => g === 'weak').length;
  return {
    verdict: 'reviewed', source: 'model',
    detail: `${ann.annotations.length} annotations, ${weak} weak skills`,
    annotations: ann,
    // The learner really did write something, so this is not a downgrade of what they did — it is
    // an accurate label for how it was judged. Nothing but the grader model read this draft.
    evidence: [ev(input.pageSlug, weak === 0 ? 'applied-correctly' : 'struggled',
      `writing round ${input.round}: skills ${JSON.stringify(ann.skillGrades)}`, 'model')],
  };
}

function latexParses(latex: string): boolean {
  try { latexToCompiled(latex); return true; } catch { return false; }
}

async function gradeOpenAnswer(
  question: string, answer: string, slug: string, cfg: HarnessConfig, deps: GradingDeps = {},
  expected?: string,
): Promise<Grade> {
  // `expected` (quick_check's fallback path) reaches only the PROMPT — grading context for the
  // model, never copied into the evidence note.
  const prompt = `Question: ${question}\n${expected ? `A correct answer conveys: ${expected}\n` : ''}Student answer: ${answer}\nReply with exactly CORRECT or INCORRECT followed by a one-line reason.`;
  const graderModelId = cfg.models.grader.model;
  let text: string;
  if (isClaudeSdkModel(graderModelId)) {
    const sdkGenerate = deps.sdkGenerate ?? claudeSdkGenerate;
    ({ text } = await sdkGenerate({ model: stripClaudeSdkPrefix(graderModelId), prompt, maxTurns: 1 }));
  } else {
    ({ text } = await generateText({ model: modelFor('grader', cfg), prompt }));
  }
  const ok = /^CORRECT/i.test(text.trim());
  return {
    verdict: ok ? 'correct' : 'incorrect', source: 'model', detail: text.trim(),
    // Already 'explained-correctly' before capApplied existed — this path is where the convention
    // the rest of the file only half-followed was originally right.
    evidence: [ev(slug, ok ? 'applied-correctly' : 'struggled', `open answer: ${question}`, 'model')],
  };
}
