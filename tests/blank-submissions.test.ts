/**
 * One sweep across every block type: submit NOTHING and assert none of them grades it correct.
 *
 * This file exists because a four-item quiz submitted entirely empty came back 4/4 CORRECT and
 * minted evidence on four pages. That hole was one branch deep in one block; the same shape could
 * live in any of the others, and the property is identical everywhere — nothing submitted cannot
 * demonstrate knowledge. Testing it per-block, in one place, is how it stays fixed.
 *
 * The injected grader is deliberately not a working model. Any block that consults a grader on an
 * empty submission therefore fails this test — either by returning `correct`, or by blowing up on
 * a model that cannot answer. Both are regressions; the property under test is that no block asks
 * anyone whether nothing is a correct answer.
 */
import { describe, it, expect } from 'vitest';
import { gradeBlockOutput } from '../src/server/grading.js';

const cfg = { vault: '/tmp', student: 'kid', models: {} } as any;
const yesMan = {
  model: { generateText: async () => ({ text: 'CORRECT — looks right', usage: {} }) },
} as any;

const CASES: [string, any, any][] = [
  ['quick_check (short answer)',
    { question: 'Explain name mangling', pageSlug: 'p', mode: 'short' },
    { answer: '' }],
  ['quick_check (whitespace only)',
    { question: 'Explain name mangling', pageSlug: 'p', mode: 'short' },
    { answer: '   \n\t ' }],
  ['quiz (every item blank)',
    { title: 'q', items: [{ id: 'a', type: 'short', prompt: 'Explain A', pageSlug: 'p' }] },
    { answers: [{ id: 'a', answer: '' }] }],
  ['writing_draft (rubric)',
    { prompt: 'Argue X', pageSlug: 'p', rubric: ['has a thesis'] },
    { draft: '' }],
  ['writing_draft (no rubric)',
    { prompt: 'Argue X', pageSlug: 'p' },
    { draft: '   ' }],
  ['structured_check (numeric)',
    { prompt: 'How much heat?', pageSlug: 'p', checker: { kind: 'numeric', expected: 42 } },
    { values: [''] }],
  ['structured_check (set)',
    { prompt: 'Name the halogens', pageSlug: 'p', checker: { kind: 'set', expected: ['F', 'Cl'] } },
    { values: [''] }],
  ['structured_check (pattern)',
    { prompt: 'What is it?', pageSlug: 'p', checker: { kind: 'pattern', expected: 'mangled' } },
    { values: [''] }],
  ['math_scratchpad',
    { problemLatex: 'x^2', pageSlug: 'p', expectedLatex: '2x' },
    { steps: [], finalLatex: '' }],
];

describe('no block grades an empty submission correct', () => {
  it.each(CASES)('%s', async (_name, input, output) => {
    const g = await gradeBlockOutput(_name.split(' ')[0] as any, input, output, cfg, yesMan);
    expect(g.verdict).not.toBe('correct');
    // And nothing positive may be minted for it.
    for (const e of g.evidence ?? []) {
      expect(['struggled', 'misconception', 'exposed']).toContain(e.kind);
    }
  });
});
