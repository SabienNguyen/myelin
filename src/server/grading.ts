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
  perItem?: { id: string; correct: boolean }[];
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
    const detail = numOk
      ? (unitOk ? 'value and unit match' : `value matches but the unit should be ${checker.unit}`)
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

  // pattern
  const ok = normKey(clean[0] ?? '') === normKey(checker.expected);
  return { allCorrect: ok, anyCorrect: ok, detail: ok ? 'exact match' : `expected "${checker.expected}"` };
}

export interface Grade {
  verdict: 'correct' | 'partial' | 'incorrect' | 'reviewed';
  detail: string;
  perItem?: { id: string; correct: boolean }[];
  annotations?: WritingAnnotations;
  evidence: { slug: string; kind: EvidenceKind; note: string }[];
}

const ev = (slug: string, kind: EvidenceKind, note: string) => ({ slug, kind, note });

export async function gradeBlockOutput(
  tool: BlockToolName, input: any, result: any, cfg: HarnessConfig, deps: GradingDeps = {},
): Promise<Grade> {
  if (tool === 'quick_check') {
    if (input.expected != null) {
      const ok = result.answer.trim().toLowerCase() === input.expected.trim().toLowerCase();
      return {
        verdict: ok ? 'correct' : 'incorrect',
        detail: ok ? 'exact match' : `expected "${input.expected}"`,
        evidence: [ev(input.pageSlug, ok ? 'applied-correctly' : 'struggled', `quick_check: ${input.question}`)],
      };
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
      detail: finalOk ? 'final answer numerically equivalent'
        : `final differs from expected${badStep >= 0 ? `; step ${badStep + 1} unparseable` : ''}`,
      evidence: [ev(input.pageSlug, finalOk ? 'applied-correctly' : 'struggled',
        `math: ${input.problemLatex} → ${result.finalLatex}`)],
    };
  }

  if (tool === 'quiz') {
    const perItem = await Promise.all(input.items.map(async (item: any) => {
      const answer = result.answers.find((a: any) => a.id === item.id)?.answer ?? '';
      if (item.type !== 'short' && item.expected != null)
        return { id: item.id, correct: answer.trim().toLowerCase() === item.expected.trim().toLowerCase() };
      const g = await gradeOpenAnswer(item.prompt, answer, item.pageSlug, cfg, deps);
      return { id: item.id, correct: g.verdict === 'correct' };
    }));
    const right = perItem.filter((p) => p.correct).length;
    const bySlug = new Map<string, { right: number; total: number }>();
    for (const item of input.items) {
      const s = bySlug.get(item.pageSlug) ?? { right: 0, total: 0 };
      s.total++; if (perItem.find((p) => p.id === item.id)?.correct) s.right++;
      bySlug.set(item.pageSlug, s);
    }
    return {
      verdict: right === perItem.length ? 'correct' : right > 0 ? 'partial' : 'incorrect',
      detail: `${right}/${perItem.length}`, perItem,
      evidence: [...bySlug].map(([slug, s]) =>
        ev(slug, s.right === s.total ? 'applied-correctly' : 'struggled', `quiz ${s.right}/${s.total}`)),
    };
  }

  // structured_check — the generic applied block. MECHANICAL throughout: no model is consulted for
  // any checker, which is what lets applied evidence generalise to subjects nobody hand-authored.
  if (tool === 'structured_check') {
    const g = gradeStructured(input.checker, result.values ?? []);
    const kind: EvidenceKind = g.allCorrect ? 'applied-correctly' : 'struggled';
    return {
      verdict: g.allCorrect ? 'correct' : g.anyCorrect ? 'partial' : 'incorrect',
      detail: g.detail,
      ...(g.perItem ? { perItem: g.perItem } : {}),
      evidence: [ev(input.pageSlug, kind, `${input.checker.kind} check: ${input.prompt}`)],
    };
  }

  if (tool === 'code_exercise') {
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
    const note = result.completed
      ? (result.wroteCode
        ? (revealed
          ? 'passed real tests with own code, but revealed expected values — capped at exposed'
          : 'passed real tests with own code')
        : `completed ${result.rungReached} (guided)`)
      : `stopped at ${result.rungReached}`;
    return {
      verdict: result.completed ? 'correct' : 'incorrect',
      detail: `${result.testsPassed}/${result.testsTotal} tests`,
      evidence: [ev(input.pageSlug, kind, note)],
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
    verdict: 'reviewed', detail: `${ann.annotations.length} annotations, ${weak} weak skills`,
    annotations: ann,
    evidence: [ev(input.pageSlug, weak === 0 ? 'applied-correctly' : 'struggled',
      `writing round ${input.round}: skills ${JSON.stringify(ann.skillGrades)}`)],
  };
}

function latexParses(latex: string): boolean {
  try { latexToCompiled(latex); return true; } catch { return false; }
}

async function gradeOpenAnswer(
  question: string, answer: string, slug: string, cfg: HarnessConfig, deps: GradingDeps = {},
): Promise<Grade> {
  const prompt = `Question: ${question}\nStudent answer: ${answer}\nReply with exactly CORRECT or INCORRECT followed by a one-line reason.`;
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
    verdict: ok ? 'correct' : 'incorrect', detail: text.trim(),
    evidence: [ev(slug, ok ? 'explained-correctly' : 'struggled', `open answer: ${question}`)],
  };
}
