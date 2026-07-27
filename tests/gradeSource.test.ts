// The rule that gives `applied-correctly` its meaning: ONLY MECHANICALLY-VERIFIED WORK MAY MINT IT.
//
// This file exists because that rule was previously unwritten and unenforced. It held across the
// mechanical blocks by convention, and two blocks broke it silently:
//
//   * `quiz` routed short-answer items through the grader model, then aggregated them per slug into
//     'applied-correctly' — so a quiz of nothing but short answers, judged entirely by a model,
//     recorded the same evidence as passing a real test suite.
//   * `writing_draft` is model-graded end to end and minted 'applied-correctly' whenever no skill
//     came back weak.
//
// Nothing failed when they did that, because no test asserted the rule and `applyEvidence` treats
// 'explained-correctly' and 'applied-correctly' identically (loreweaver src/student/model.ts — both
// step exactly one rung). The convention was doing all the work and there was no mechanism.
//
// The test below is deliberately a PROPERTY over every block type rather than one assertion per
// block: the failure mode being guarded is a SEVENTH block, added later, that forgets. A per-block
// test cannot catch that; a loop over BLOCK_TOOL_NAMES can.

import { describe, it, expect } from 'vitest';
import { gradeBlockOutput, capApplied, type Grade, type GradeSource } from '../src/server/grading.js';
import type { HarnessConfig } from '../src/server/config.js';

/** Grader that always approves, so every model-graded path takes its most generous branch — the
 *  only branch that could ever produce 'applied-correctly'. A grader that failed everything would
 *  make this whole file pass vacuously.
 *
 *  Two response shapes because the two model paths want different things: gradeOpenAnswer parses a
 *  leading CORRECT/INCORRECT, writing_draft parses JSON. Keyed off the prompt rather than a flag,
 *  so adding a third model-graded block does not silently get the wrong shape. */
const yesGrader = {
  sdkGenerate: async ({ prompt }: { prompt: string }) => ({
    text: /criteria/i.test(prompt) && /rubric|criterion/i.test(prompt)
      ? JSON.stringify({
        criteria: [
          { criterion: 'thesis is arguable', pass: true, note: 'yes' },
          { criterion: 'cites a source', pass: true, note: 'yes' },
        ],
      })
      : /annotations/i.test(prompt)
        ? JSON.stringify({
          annotations: [],
          skillGrades: { claim: 'good', concision: 'good', specificity: 'good' },
        })
        : 'CORRECT — fine.',
  }),
};
const cfg = {
  models: { grader: { model: 'claude-sdk:sonnet' } },
} as unknown as HarnessConfig;

/** A best case for every block: the input and result that earn the highest evidence each can give. */
const BEST_CASE: { tool: any; input: any; result: any; expect: GradeSource }[] = [
  {
    tool: 'quick_check',
    input: { question: 'q', expected: '2x', pageSlug: 'p' },
    result: { answer: '2x' },
    expect: 'mechanical',
  },
  {
    tool: 'quick_check',
    // No `expected` — the open-answer path, which is the grader model.
    input: { question: 'q', pageSlug: 'p' },
    result: { answer: 'a paragraph of explanation' },
    expect: 'model',
  },
  {
    tool: 'math_scratchpad',
    input: { problemLatex: 'x^2', expectedLatex: '2x', variable: 'x', pageSlug: 'p' },
    result: { steps: [], finalLatex: '2x' },
    expect: 'mechanical',
  },
  {
    tool: 'quiz',
    input: { items: [{ id: '1', type: 'choice', prompt: 'q', expected: 'a', pageSlug: 'p' }] },
    result: { answers: [{ id: '1', answer: 'a' }] },
    expect: 'mechanical',
  },
  {
    tool: 'quiz',
    // All short answers: the case that used to mint applied-correctly off a model's opinion.
    input: { items: [{ id: '1', type: 'short', prompt: 'explain', pageSlug: 'p' }] },
    result: { answers: [{ id: '1', answer: 'because of the chain rule' }] },
    expect: 'model',
  },
  {
    tool: 'quiz',
    // Mixed: one exact-matched item and one model-graded item on the SAME slug, both right.
    input: {
      items: [
        { id: '1', type: 'choice', prompt: 'q', expected: 'a', pageSlug: 'p' },
        { id: '2', type: 'short', prompt: 'explain', pageSlug: 'p' },
      ],
    },
    result: { answers: [{ id: '1', answer: 'a' }, { id: '2', answer: 'because' }] },
    expect: 'model',
  },
  {
    tool: 'structured_check',
    input: { prompt: 'q', checker: { kind: 'numeric', expected: 42 }, pageSlug: 'p' },
    result: { values: ['42'] },
    expect: 'mechanical',
  },
  {
    tool: 'code_exercise',
    input: { pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'p' },
    result: { completed: true, rungReached: 'full_body', testsPassed: 8, testsTotal: 8, wroteCode: true },
    expect: 'mechanical',
  },
  {
    tool: 'label_diagram',
    input: {
      prompt: 'label the heart', pageSlug: 'p',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      regions: [
        { id: 'a', x: 10, y: 10, label: 'aorta' },
        { id: 'b', x: 60, y: 60, label: 'left ventricle' },
      ],
    },
    result: { placements: [{ regionId: 'a', label: 'aorta' }, { regionId: 'b', label: 'left ventricle' }] },
    expect: 'mechanical',
  },
  {
    tool: 'writing_draft',
    input: { prompt: 'write', round: 1, pageSlug: 'p' },
    result: { draft: 'a strong, concise, specific paragraph.' },
    expect: 'model',
  },
  {
    tool: 'writing_draft',
    // The rubric path: judged WORK. Its best case mints 'rubric-passed' — a model verdict that is
    // allowed to exist precisely because it is named as one, never as applied.
    input: {
      prompt: 'argue it', round: 1, pageSlug: 'p',
      rubric: ['thesis is arguable', 'cites a source'],
    },
    result: { draft: 'a draft with a thesis and a source.' },
    expect: 'model',
  },
];

const grade = (c: typeof BEST_CASE[number]): Promise<Grade> =>
  gradeBlockOutput(c.tool, c.input, c.result, cfg, yesGrader as any);

describe('every grade declares where its verdict came from', () => {
  for (const c of BEST_CASE) {
    const label = `${c.tool}${c.tool === 'quiz' || c.tool === 'quick_check' ? ` (${c.expect})` : ''}`;
    it(`${label} reports source "${c.expect}"`, async () => {
      expect((await grade(c)).source).toBe(c.expect);
    });
  }
});

describe('THE RULE: a model-graded verdict can never mint applied-correctly', () => {
  for (const c of BEST_CASE) {
    const label = `${c.tool} (${c.expect})`;
    it(label, async () => {
      const g = await grade(c);
      const kinds = g.evidence.map((e) => e.kind);
      if (g.source === 'model') {
        expect(kinds).not.toContain('applied-correctly');
      } else {
        // The mechanical half of the property matters just as much: if the cap were applied
        // everywhere, this file would pass while quietly making real test suites worthless.
        expect(kinds).toContain('applied-correctly');
      }
    });
  }

  it('a full rubric pass mints rubric-passed — and never applied-correctly', async () => {
    const rubricCase = BEST_CASE.find((c) => c.tool === 'writing_draft' && c.input.rubric)!;
    const g = await grade(rubricCase);
    expect(g.evidence.map((e) => e.kind)).toEqual(['rubric-passed']);
    expect(g.rubric?.every((r) => r.pass)).toBe(true);
  });

  it('a criterion the grader forgot to address FAILS — the rubric is authoritative, not the model', async () => {
    const forgetful = {
      sdkGenerate: async () => ({
        text: JSON.stringify({ criteria: [{ criterion: 'thesis is arguable', pass: true, note: 'ok' }] }),
      }),
    };
    const rubricCase = BEST_CASE.find((c) => c.tool === 'writing_draft' && c.input.rubric)!;
    const g = await gradeBlockOutput(rubricCase.tool, rubricCase.input, rubricCase.result, cfg, forgetful as any);
    // One of two criteria unaddressed -> not a pass. A grader cannot pass a draft by omission.
    expect(g.evidence.map((e) => e.kind)).toEqual(['struggled']);
    expect(g.rubric?.find((r) => r.criterion === 'cites a source')?.pass).toBe(false);
  });

  it('holds for the aggregate too — one model-graded item taints the whole quiz slug', async () => {
    const mixed = BEST_CASE.find((c) => c.tool === 'quiz' && Array.isArray(c.input.items) && c.input.items.length === 2)!;
    const g = await grade(mixed);
    expect(g.verdict).toBe('correct');           // the learner got everything right
    expect(g.source).toBe('model');              // but not everything was checked
    expect(g.evidence.map((e) => e.kind)).toEqual(['explained-correctly']);
    expect(g.evidence[0].note).toContain('model-graded');
    // Per-item sources survive into perItem, so the graded card can mark WHICH items were judged.
    expect(g.perItem).toEqual([
      { id: '1', source: 'mechanical', correct: true },
      { id: '2', source: 'model', correct: true },
    ]);
  });

  it('covers every block type the schema declares, so a new block cannot slip through', async () => {
    // If someone adds a seventh block tool, this fails until they add a best case above — which is
    // the only way the property can keep meaning what it says.
    const { BLOCK_TOOL_NAMES } = await import('../src/shared/blocks.js');
    const covered = new Set(BEST_CASE.map((c) => c.tool));
    expect([...BLOCK_TOOL_NAMES].filter((t) => !covered.has(t))).toEqual([]);
  });
});

describe('capApplied', () => {
  it('downgrades a model-graded pass to explained-correctly', () => {
    expect(capApplied('applied-correctly', 'model')).toBe('explained-correctly');
  });

  it('leaves a mechanically-verified pass alone', () => {
    expect(capApplied('applied-correctly', 'mechanical')).toBe('applied-correctly');
  });

  it('does not touch any other kind, from either source', () => {
    // A model is perfectly able to observe that an answer was wrong, so 'struggled' needs no
    // ceiling; capping it would let a learner escape a bad result by being graded by a model.
    for (const source of ['model', 'mechanical'] as GradeSource[]) {
      for (const kind of ['struggled', 'exposed', 'explained-correctly', 'misconception'] as const) {
        expect(capApplied(kind, source)).toBe(kind);
      }
    }
  });
});

describe('quiz short items with an expected answer (audit 27)', () => {
  // The audit drove a quiz whose short answer WAS the expected string verbatim — and the judge
  // marked it ✗. Short items must follow the quick_check discipline: exact match is mechanically
  // correct and never consults a model; only a miss goes to the judge, with `expected` as context.
  const item = { id: 's1', type: 'short', prompt: 'which option?', expected: 'stream: true', pageSlug: 'p' };
  const input = { items: [item] };

  it('an exact match is mechanically correct — the model is never consulted', async () => {
    const angryGrader = {
      sdkGenerate: async () => { throw new Error('the model must not be consulted for an exact match'); },
    };
    const g = await gradeBlockOutput('quiz', input, { answers: [{ id: 's1', answer: ' Stream: TRUE ' }] }, cfg, angryGrader as any);
    expect(g.verdict).toBe('correct');
    expect(g.source).toBe('mechanical');
    expect(g.perItem).toEqual([{ id: 's1', source: 'mechanical', correct: true }]);
  });

  it('a miss goes to the judge WITH the expected answer as context', async () => {
    const prompts: string[] = [];
    const spyGrader = {
      sdkGenerate: async ({ prompt }: { prompt: string }) => { prompts.push(prompt); return { text: 'CORRECT — same thing.' }; },
    };
    const g = await gradeBlockOutput('quiz', input, { answers: [{ id: 's1', answer: 'the streaming flag' }] }, cfg, spyGrader as any);
    expect(g.perItem).toEqual([{ id: 's1', source: 'model', correct: true }]);
    expect(prompts.join('\n')).toContain('stream: true');
  });
});
