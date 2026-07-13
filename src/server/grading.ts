import { convertLatexToAsciiMath } from 'mathlive';
import { create, all } from 'mathjs';
import { generateText, Output } from 'ai';
import { annotationSchema, type BlockToolName, type WritingAnnotations } from '../shared/blocks.js';
import type { EvidenceKind } from '../shared/loreweaver.js';
import { modelFor } from './models.js';
import type { HarnessConfig } from './config.js';

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
  tool: BlockToolName, input: any, result: any, cfg: HarnessConfig,
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
    return gradeOpenAnswer(input.question, result.answer, input.pageSlug, cfg);
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
      const g = await gradeOpenAnswer(item.prompt, answer, item.pageSlug, cfg);
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

  // writing_draft — grader role, structured output
  const { output } = await generateText({
    model: modelFor('grader', cfg),
    prompt: `Grade this student draft. Prompt: "${input.prompt}"\nDraft:\n${result.draft}\n` +
      `Return annotations whose "span" values are EXACT substrings of the draft, and per-skill grades for: claim, concision, specificity.`,
    output: Output.object({ schema: annotationSchema }),
  });
  const ann = output as WritingAnnotations;
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

async function gradeOpenAnswer(question: string, answer: string, slug: string, cfg: HarnessConfig): Promise<Grade> {
  const { text } = await generateText({
    model: modelFor('grader', cfg),
    prompt: `Question: ${question}\nStudent answer: ${answer}\nReply with exactly CORRECT or INCORRECT followed by a one-line reason.`,
  });
  const ok = /^CORRECT/i.test(text.trim());
  return {
    verdict: ok ? 'correct' : 'incorrect', detail: text.trim(),
    evidence: [ev(slug, ok ? 'explained-correctly' : 'struggled', `open answer: ${question}`)],
  };
}
