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

/** The Agent SDK path has no Output.object, so its graders ask for JSON-only text — and the live
 *  model still sometimes wraps the JSON in a markdown fence despite that instruction (a probe
 *  lost an entire grade turn to the resulting JSON.parse throw). Unwrap one fence when present;
 *  text that still fails to parse throws with the raw head attached so the failure stays
 *  readable. */
export function parseSdkJson<T>(text: string, who: string): T {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1] : text.trim();
  try {
    return JSON.parse(body) as T;
  } catch (e) {
    throw new Error(`${who} returned invalid JSON: ${(e as Error).message}. Raw: ${text.slice(0, 300)}`);
  }
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

/** Top-level split of a normalized AsciiMath string on a single bare '=' — the equation shape
 * students actually write algebra in ("2x+3=11 → 2x=8 → x=4"). mathjs reads '=' as ASSIGNMENT:
 * it happens to evaluate when the left side is a bare symbol ("x=4") and THROWS for any other
 * left side ("2x=8"), so before this split existed a perfectly ordinary equation step was
 * reported "unparseable" and the break-locating walker skipped equation-form derivations
 * entirely. Comparison spellings (<=, >=, !=, ==) are not equations and are left alone. */
function splitEquation(am: string): [string, string] | null {
  let depth = 0;
  for (let i = 0; i < am.length; i++) {
    const c = am[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '=' && depth === 0) {
      const prev = am[i - 1], next = am[i + 1];
      if (prev === '<' || prev === '>' || prev === '!' || prev === '=' || next === '=') continue;
      const lhs = am.slice(0, i).trim(), rhs = am.slice(i + 1).trim();
      return lhs && rhs ? [lhs, rhs] : null;
    }
  }
  return null;
}

/** freeVariables' core on an already-normalized AsciiMath EXPRESSION (one side of an equation). */
function detectedVars(am: string): string[] {
  try {
    const node = math.parse(am);
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

/** Free variables actually referenced by a LaTeX expression. mathjs parses to an AST whose
 * SymbolNodes are either variables or function names; a symbol used as a call target
 * (`sin(x)`) is a FunctionNode's fn, so filtering on `isSymbolNode` alone would wrongly collect
 * `sin`. Constants mathjs defines itself (pi, e, i, …) are excluded by checking the default scope.
 * Equations contribute the variables of BOTH sides. Returns [] rather than throwing on
 * unparseable input — callers already treat that as not-equal. */
export function freeVariables(latex: string): string[] {
  try {
    const am = normalizeAsciiMath(latex);
    const sides = splitEquation(am) ?? [am];
    return [...new Set(sides.flatMap(detectedVars))].sort();
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
    const amA = normalizeAsciiMath(a), amB = normalizeAsciiMath(b);
    const eqA = splitEquation(amA), eqB = splitEquation(amB);

    // Equation vs expression: an equation that ISOLATES a symbol ("x=4", "V = nRT/P") means its
    // other side — compare that side to the expression, so a student answering "x=4" against an
    // expected "4" is correct by design, not by mathjs's assignment accident. An equation that
    // isolates nothing ("2x=8") has no expression reading and is honestly not equivalent to one.
    if (!eqA !== !eqB) {
      const [eq, otherAm] = eqA ? [eqA, amB] as const : [eqB!, amA] as const;
      const bare = /^[A-Za-z][A-Za-z0-9_]*$/;
      const side = bare.test(eq[0]) ? eq[1] : bare.test(eq[1]) ? eq[0] : null;
      return side !== null && sampledEqual(side, otherAm, vars, eps);
    }
    // Two equations state the same thing when their residuals (lhs − rhs) are proportional by a
    // nonzero constant — "2x=8" vs "x=4" (ratio 2) or any add/subtract/scale of both sides. A
    // varying ratio means the solution sets differ ("x^2=4" vs "x=2": one root vs two).
    if (eqA && eqB) return residualsProportional(eqA, eqB, vars, eps);
    return sampledEqual(amA, amB, vars, eps);
  } catch { return false; }
}

/** Sampling scope for point k — stride 2i+1 is coprime-ish with SAMPLES.length (7) for small i,
 * so variables sweep the sample set out of phase with each other instead of moving together. */
function scopeAt(names: string[], k: number): Record<string, number> {
  const scope: Record<string, number> = {};
  names.forEach((name, i) => {
    scope[name] = SAMPLES[(k * (2 * i + 1) + i * 3) % SAMPLES.length];
  });
  return scope;
}

function sampleNames(ams: string[], vars?: string | string[]): string[] {
  const declared = vars === undefined ? [] : (Array.isArray(vars) ? vars : [vars]);
  const names = [...new Set([...declared, ...ams.flatMap(detectedVars)])];
  // Fall back to 'x' so a caller passing nothing against a constant-only pair still samples once.
  if (names.length === 0) names.push('x');
  return names;
}

/** The original mathEquivalent core, on normalized AsciiMath expressions. */
function sampledEqual(amA: string, amB: string, vars?: string | string[], eps = 1e-9): boolean {
  const fa = math.compile(amA), fb = math.compile(amB);
  const names = sampleNames([amA, amB], vars);
  const points = names.length === 1 ? SAMPLES.length : SAMPLES.length * 3;
  for (let k = 0; k < points; k++) {
    let ra: number, rb: number;
    try { ra = fa.evaluate(scopeAt(names, k)); rb = fb.evaluate(scopeAt(names, k)); } catch { continue; }
    if (typeof ra !== 'number' || typeof rb !== 'number') continue; // matrices/units — not sampled
    if (Number.isNaN(ra) && Number.isNaN(rb)) continue;
    if (Math.abs(ra - rb) > eps * Math.max(1, Math.abs(ra), Math.abs(rb))) return false;
  }
  return true;
}

function residualsProportional(
  eqA: [string, string], eqB: [string, string], vars?: string | string[], eps = 1e-9,
): boolean {
  const fa = math.compile(`(${eqA[0]})-(${eqA[1]})`);
  const fb = math.compile(`(${eqB[0]})-(${eqB[1]})`);
  const names = sampleNames([...eqA, ...eqB], vars);
  const points = names.length === 1 ? SAMPLES.length : SAMPLES.length * 3;
  let ratio: number | undefined;
  let sawPoint = false;
  for (let k = 0; k < points; k++) {
    let ra: number, rb: number;
    try { ra = fa.evaluate(scopeAt(names, k)); rb = fb.evaluate(scopeAt(names, k)); } catch { continue; }
    if (typeof ra !== 'number' || typeof rb !== 'number') continue;
    if (Number.isNaN(ra) || Number.isNaN(rb)) continue;
    sawPoint = true;
    const zeroA = Math.abs(ra) <= eps, zeroB = Math.abs(rb) <= eps;
    if (zeroA && zeroB) continue;      // a shared root — consistent, but no ratio to read
    if (zeroA !== zeroB) return false; // a root of one that the other doesn't have
    const r = ra / rb;
    if (ratio === undefined) ratio = r;
    else if (Math.abs(r - ratio) > 1e-6 * Math.max(1, Math.abs(r), Math.abs(ratio))) return false;
  }
  // Every sampled point a shared root (e.g. "1=1" vs "2·0=0"): identically-true statements agree.
  // No evaluable point at all: nothing was checked — refuse to call that equivalent.
  return ratio !== undefined || sawPoint;
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

/** The number a learner's free-text answer MEANS. A live session-plan sitting answered a numeric
 * check with its full derivation — "C = 1/2 (1 - 0.8)^2 = ... = 0.02" — and was told "no number
 * found in the answer": parseLeadingNumber anchors at the string's start, and showing your work
 * is the one thing a tutor must never punish. Conservative ladder, first hit wins:
 *   1. leading number (unchanged fast path — keeps "9.81 m/s^2" ignoring the exponent's 2);
 *   2. the number right after the LAST '=' — the final-answer convention of any derivation,
 *      and of "x = 4";
 *   3. the string's only number token, if there is exactly one — "about 0.02", "answer: 0.02".
 * Anything still ambiguous ("between 3 and 5") stays NaN: guessing which number a learner meant
 * is worse than asking them to restate it. */
export function extractAnswerNumber(s: string): number {
  const lead = parseLeadingNumber(s);
  if (!Number.isNaN(lead)) return lead;
  const lastEq = s.lastIndexOf('=');
  if (lastEq !== -1) {
    const after = parseLeadingNumber(s.slice(lastEq + 1));
    if (!Number.isNaN(after)) return after;
  }
  const tokens = s.replace(/,(?=\d{3}\b)/g, '').match(/[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/g);
  return tokens?.length === 1 ? Number(tokens[0]) : NaN;
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
    const got = extractAnswerNumber(clean[0] ?? '');
    if (Number.isNaN(got)) {
      return { allCorrect: false, anyCorrect: false, detail: 'no number found in the answer' };
    }
    // Default tolerance is a hair above float noise rather than 0, so 0.1+0.2 style answers pass.
    const tol = checker.tolerance ?? 1e-9;
    const limit = checker.relative ? Math.abs(checker.expected) * tol : tol;
    const numOk = Math.abs(got - checker.expected) <= limit;
    // Unit is checked only when the question asked for one, and only as a normalised substring —
    // "m/s^2", "m/s2" and "M/S^2" all satisfy a declared "m/s^2". Unicode superscripts fold to
    // digits first: prompts render units as m/s² (KaTeX) and the answer preview echoes ², so a
    // learner who copies or types the printed form must not be told their unit is wrong.
    const foldSup = (s: string) => s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]/g,
      (c) => '0123456789+-'['⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻'.indexOf(c)]);
    const unitKey = (s: string) => foldSup(normKey(s)).replace(/[\s^]/g, '');
    // '%' is formatting, not a unit that changes meaning: a bare "0.1" against an expected-%
    // checker cannot mean anything else (a fraction-vs-percent confusion fails the NUMERIC
    // comparison already). A live check dinged a learner `struggled` for answering "0.1" when
    // the tutor's own example said 'e.g. "5" for 5%' — bare numbers must satisfy a % unit,
    // though an explicitly different unit ("0.1 kg") still fails it.
    const bareNumber = !/[a-z%]/i.test((clean[0] ?? '').trim());
    const unitOk = !checker.unit
      || unitKey(clean[0] ?? '').includes(unitKey(checker.unit))
      || (checker.unit.trim() === '%' && bareNumber);
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
    // The step call-out is independent of the final's verdict: only parseability is checked, and a
    // garbled step hidden under a green final implied the whole derivation had been read. Naming it
    // both ways keeps the verdict honest about what the machine could and could not see.
    const stepNote = badStep >= 0 ? `; step ${badStep + 1} unparseable` : '';
    // WHERE the derivation broke, not just that it did (audit 41's top recommendation): on a
    // wrong final, walk adjacent parseable pairs (steps, then last step -> final) and name the
    // first non-equivalent transition. Verdict TEXT only, never the grade — and only on a miss,
    // because legitimate derivations contain non-equivalent lines (a differentiation step IS
    // one) and flagging those under a green final would cry wolf.
    let breakNote = '';
    if (!finalOk && input.stepMode && Array.isArray(result.steps) && result.steps.length > 0) {
      const vars = input.variables ?? input.variable;
      const chain: string[] = [...result.steps.map((s: { latex: string }) => s.latex), result.finalLatex];
      for (let i = 0; i < chain.length - 1; i++) {
        if (!latexParses(chain[i]) || !latexParses(chain[i + 1])) continue;
        if (!mathEquivalent(chain[i], chain[i + 1], vars)) {
          breakNote = i + 1 === chain.length - 1
            ? `; the work first breaks between the last step and the final answer`
            : `; the work first breaks between steps ${i + 1} and ${i + 2}`;
          break;
        }
      }
    }
    return {
      verdict: finalOk ? 'correct' : 'incorrect',
      source: 'mechanical',
      detail: (finalOk ? 'final answer numerically equivalent' : 'final differs from expected') + stepNote + breakNote,
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
    // "submit anyway": the block lets a learner commit a run whose suite is still red (completed:
    // true, testsPassed < testsTotal) — and wroteCode is the client's "edited the scaffold" diff,
    // not "passed with own code" (CodeExercise.tsx computes it off the doc, never the results). So
    // completed && wroteCode alone minted 'applied-correctly' with the note "passed real tests"
    // for a 1/4 submission — observed live in audit 45. A red suite is a diagnosis, not a pass:
    // it earns 'struggled', same as stopping.
    const suiteGreen = result.testsPassed === result.testsTotal;
    const earned: EvidenceKind = !result.completed || !suiteGreen ? 'struggled'
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
    const note = !result.completed
      ? `stopped at ${result.rungReached}${failingNote}`
      : !suiteGreen
        ? `submitted with ${result.testsPassed}/${result.testsTotal} passing${failingNote}`
        : result.wroteCode
          ? (revealed
            ? 'passed real tests with own code, but revealed expected values — capped at exposed'
            : 'passed real tests with own code')
          : `completed ${result.rungReached} (guided)`;
    // `detail` used to be `${testsPassed}/${testsTotal} tests`, which the graded card ALREADY
    // renders one line above — the same number twice, and no room left to say the thing neither
    // line said: which evidence this run actually minted. That mattered most in the reveal case,
    // where a learner saw a green 5/5 and no indication their evidence had been capped. It also
    // reaches the tutor (session.ts appends every grade's verdict + detail to the thread), so the
    // tutor now knows the ceiling applied rather than inferring a clean pass from "5/5 tests".
    const detail = !result.completed
      ? `recorded as struggled — stopped at ${result.rungReached}${failingNote}`
      : !suiteGreen
        ? `recorded as struggled — submitted with a failing suite${failingNote}`
        : kind === 'applied-correctly'
          ? 'recorded as applied-correctly'
          : revealed
            ? 'recorded as exposed — expected values were revealed, so this cannot count as applying the pattern'
            : 'recorded as exposed — guided rungs only, no code of your own was graded';
    return {
      verdict: result.completed && suiteGreen ? 'correct' : 'incorrect',
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
    const judgeRubric = async (): Promise<{ criteria: { criterion: string; pass: boolean; note: string }[] }> => {
      if (isClaudeSdkModel(graderId)) {
        const sdkGenerate = deps.sdkGenerate ?? claudeSdkGenerate;
        const { text } = await sdkGenerate({
          model: stripClaudeSdkPrefix(graderId),
          prompt: `${rubricPrompt}\n\nRespond with ONLY valid JSON: {"criteria": [{"criterion": <string>, "pass": <boolean>, "note": <string>}]}`,
          maxTurns: 1,
        });
        return parseSdkJson(text, 'claude-sdk rubric judge');
      }
      const { output } = await generateText({
        model: modelFor('grader', cfg), prompt: rubricPrompt, output: Output.object({ schema: rubricSchema }),
      });
      return output as { criteria: { criterion: string; pass: boolean; note: string }[] };
    };
    // The rubric judge and the annotation grader are independent reads of the same draft — run
    // them CONCURRENTLY. In series they doubled every essay's grading latency (two model
    // round-trips back to back), which is the single slowest interaction in the app.
    const [judgedRes, annRes] = await Promise.allSettled([
      judgeRubric(), annotateDraft(input.prompt, result.draft, cfg, deps),
    ]);
    if (judgedRes.status === 'rejected') throw judgedRes.reason;
    const judged = judgedRes.value;
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
    // The rubric decides the EVIDENCE; the annotations are the FEEDBACK. Until audit 40 this path
    // returned bare pass/fail lines, so the one block whose point is prose feedback shipped none of
    // it whenever a rubric was present — a learner told "gunpowder never engaged" with no marked-up
    // sentence to anchor it. Best-effort: a rubric verdict that already landed must not be lost to
    // a failed second grader call, so the miss is logged and named in the detail the tutor reads.
    let annotations: WritingAnnotations | undefined;
    let annMiss = '';
    if (annRes.status === 'fulfilled') {
      annotations = annRes.value;
    } else {
      console.error(`writing_draft: rubric judged, but annotation grading failed: ${(annRes.reason as Error)?.message ?? annRes.reason}`);
      annMiss = '; annotations unavailable';
    }
    return {
      verdict: 'reviewed', source: 'model',
      detail: `rubric: ${passed}/${results.length} criteria met${annMiss}`,
      rubric: results,
      ...(annotations ? { annotations } : {}),
      evidence: [ev(input.pageSlug, all ? 'rubric-passed' : 'struggled',
        `rubric (${passed}/${results.length}): ${input.rubric.join('; ')}`, 'model')],
    };
  }

  // writing_draft without a rubric — annotations are the whole grade.
  const ann = await annotateDraft(input.prompt, result.draft, cfg, deps);
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

/** The annotation grader — marginalia on the draft plus per-skill grades. Shared by both
 * writing_draft paths: without a rubric it IS the grade; with one it rides along as feedback. */
async function annotateDraft(
  prompt: string, draft: string, cfg: HarnessConfig, deps: GradingDeps,
): Promise<WritingAnnotations> {
  const draftPrompt = `Grade this student draft. Prompt: "${prompt}"\nDraft:\n${draft}\n`
    + `Return annotations whose "span" values are EXACT substrings of the draft, and per-skill grades for: claim, concision, specificity.`;
  const graderModelId = cfg.models.grader.model;
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
    return parseSdkJson<WritingAnnotations>(text, 'claude-sdk grader');
  }
  const { output } = await generateText({
    model: modelFor('grader', cfg),
    prompt: draftPrompt,
    output: Output.object({ schema: annotationSchema }),
  });
  return output as WritingAnnotations;
}

function latexParses(latex: string): boolean {
  try {
    const am = normalizeAsciiMath(latex);
    const eq = splitEquation(am);
    if (eq) { math.compile(eq[0]); math.compile(eq[1]); return true; }
    math.compile(am);
    return true;
  } catch { return false; }
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
