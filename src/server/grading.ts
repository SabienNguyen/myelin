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

function latexToCompiled(latex: string) {
  const s = convertLatexToAsciiMath(latex)
    .replace(/\bln\s*\(/g, 'log(')
    .replace(/\)\s*(?=[A-Za-z0-9(])/g, ')*'); // fixes (1)/(2)x binding to 1/(2x)
  return math.compile(s);
}

export function mathEquivalent(a: string, b: string, variable = 'x', eps = 1e-9): boolean {
  try {
    const fa = latexToCompiled(a), fb = latexToCompiled(b);
    return SAMPLES.every((x) => {
      let ra: number, rb: number;
      try { ra = fa.evaluate({ [variable]: x }); rb = fb.evaluate({ [variable]: x }); } catch { return true; }
      if (Number.isNaN(ra) && Number.isNaN(rb)) return true;
      return Math.abs(ra - rb) <= eps * Math.max(1, Math.abs(ra), Math.abs(rb));
    });
  } catch { return false; }
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
    const finalOk = mathEquivalent(result.finalLatex, input.expectedLatex, input.variable);
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

  if (tool === 'code_exercise') {
    // Mechanical (docs/superpowers/plans/2026-07-20-gap-integration.md I2 contract): NEVER calls a
    // model — completed && wroteCode -> 'applied-correctly' (passed real tests with own code);
    // completed && !wroteCode -> 'exposed' (watched/completed guided rungs only, no own code
    // graded); !completed -> 'struggled' (abandoned via the "stop here" affordance).
    const kind: EvidenceKind = !result.completed ? 'struggled'
      : result.wroteCode ? 'applied-correctly' : 'exposed';
    const note = result.completed
      ? (result.wroteCode ? 'passed real tests with own code' : `completed ${result.rungReached} (guided)`)
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
