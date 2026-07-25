import { describe, it, expect } from 'vitest';
import { mathEquivalent, gradeBlockOutput } from '../src/server/grading.js';
import type { ClaudeSdkGenerateOpts, ClaudeSdkResult } from '../src/server/claudeSdk.js';

describe('mathEquivalent (numeric sampling)', () => {
  it('accepts algebraically equal forms', () => {
    expect(mathEquivalent('2x', 'x+x', 'x')).toBe(true);
    expect(mathEquivalent('\\frac{1}{2}x', '0.5x', 'x')).toBe(true); // the (1)/(2)x precedence gotcha
    expect(mathEquivalent('\\cos(x^2)\\cdot 2x', '2x\\cos(x^2)', 'x')).toBe(true);
  });
  it('rejects different functions', () => {
    expect(mathEquivalent('x^2', 'x^3', 'x')).toBe(false);
  });
  it('handles ln via rewrite', () => {
    expect(mathEquivalent('\\ln(x)', '\\ln(x)', 'x')).toBe(true);
  });
});

describe('gradeBlockOutput — mechanical paths (no LLM)', () => {
  const cfg = {} as any; // grader role must NOT be called for these
  it('grades quick_check choice', async () => {
    const g = await gradeBlockOutput('quick_check',
      { question: 'q', mode: 'choice', choices: ['3', '4'], expected: '4', pageSlug: 'arith' },
      { answer: '4' }, cfg);
    expect(g.verdict).toBe('correct');
    expect(g.evidence[0]).toMatchObject({ slug: 'arith', kind: 'applied-correctly' });
  });
  it('grades math final answer + flags wrong step', async () => {
    const g = await gradeBlockOutput('math_scratchpad',
      { problemLatex: 'x^2', stepMode: true, expectedLatex: '2x', variable: 'x', pageSlug: 'derivatives' },
      { steps: [{ latex: '2x' }], finalLatex: '2x' }, cfg);
    expect(g.verdict).toBe('correct');
    const bad = await gradeBlockOutput('math_scratchpad',
      { problemLatex: 'x^2', stepMode: true, expectedLatex: '2x', variable: 'x', pageSlug: 'derivatives' },
      { steps: [{ latex: 'x' }], finalLatex: 'x' }, cfg);
    expect(bad.verdict).toBe('incorrect');
    expect(bad.evidence[0].kind).toBe('struggled');
  });

  // code_exercise (docs/superpowers/plans/2026-07-20-gap-integration.md I2 contract): mechanical,
  // never calls the grader model — `cfg = {} as any` above enforces that (a stray model call would
  // throw reading cfg.models.grader).
  it('completed + wroteCode -> applied-correctly', async () => {
    const g = await gradeBlockOutput('code_exercise',
      { pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' },
      { completed: true, rungReached: 'full_body', testsPassed: 8, testsTotal: 8, wroteCode: true }, cfg);
    expect(g.verdict).toBe('correct');
    expect(g.detail).toBe('8/8 tests');
    expect(g.evidence[0]).toMatchObject({ slug: 'stream-consumer', kind: 'applied-correctly' });
  });
  // Reveal ceiling: expected-vs-actual is available in TestResultsPanel, but a run that used it
  // cannot mint 'applied-correctly' — same shape as the Anki-review ceiling.
  it('completed + wroteCode + revealedExpected -> capped at exposed, not applied-correctly', async () => {
    const g = await gradeBlockOutput('code_exercise',
      { pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' },
      {
        completed: true, rungReached: 'full_body', testsPassed: 8, testsTotal: 8,
        wroteCode: true, revealedExpected: true,
      }, cfg);
    expect(g.verdict).toBe('correct'); // the suite really did pass — the verdict is not a lie
    expect(g.evidence[0]).toMatchObject({ slug: 'stream-consumer', kind: 'exposed' });
    expect(g.evidence[0].note).toContain('revealed expected values');
  });
  it('revealedExpected does not upgrade an abandoned run away from struggled', async () => {
    const g = await gradeBlockOutput('code_exercise',
      { pattern: 'stream-consumer', rung: 'ladder', pageSlug: 'stream-consumer' },
      {
        completed: false, rungReached: 'full_body', testsPassed: 1, testsTotal: 8,
        wroteCode: false, revealedExpected: true,
      }, cfg);
    expect(g.evidence[0]).toMatchObject({ kind: 'struggled' });
  });
  it('absent revealedExpected behaves exactly as before (optional field)', async () => {
    const g = await gradeBlockOutput('code_exercise',
      { pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' },
      { completed: true, rungReached: 'full_body', testsPassed: 8, testsTotal: 8, wroteCode: true }, cfg);
    expect(g.evidence[0]).toMatchObject({ kind: 'applied-correctly' });
    expect(g.evidence[0].note).not.toContain('revealed');
  });

  it('completed + !wroteCode (guided rungs only) -> exposed', async () => {
    const g = await gradeBlockOutput('code_exercise',
      { pattern: 'stream-consumer', rung: 'ladder', pageSlug: 'stream-consumer' },
      { completed: true, rungReached: 'inline_completion', testsPassed: 0, testsTotal: 0, wroteCode: false }, cfg);
    expect(g.evidence[0]).toMatchObject({ slug: 'stream-consumer', kind: 'exposed' });
  });
  it('!completed (abandoned via "stop here") -> struggled', async () => {
    const g = await gradeBlockOutput('code_exercise',
      { pattern: 'stream-consumer', rung: 'ladder', pageSlug: 'stream-consumer' },
      { completed: false, rungReached: 'full_body', testsPassed: 3, testsTotal: 8, wroteCode: false }, cfg);
    expect(g.verdict).toBe('incorrect');
    expect(g.detail).toBe('3/8 tests');
    expect(g.evidence[0]).toMatchObject({ slug: 'stream-consumer', kind: 'struggled' });
  });
});

describe('gradeBlockOutput — claude-sdk: prefixed grader model', () => {
  function fakeSdk(text: string) {
    const calls: ClaudeSdkGenerateOpts[] = [];
    const sdkGenerate = async (opts: ClaudeSdkGenerateOpts): Promise<ClaudeSdkResult> => {
      calls.push(opts);
      return { text, toolCallNames: [] };
    };
    return { calls, sdkGenerate };
  }

  it('routes an open quick_check answer to the fake with the question/answer in the prompt', async () => {
    const { calls, sdkGenerate } = fakeSdk('CORRECT nice work');
    const cfg = { models: { grader: { model: 'claude-sdk:sonnet' } } } as any;
    const g = await gradeBlockOutput('quick_check',
      { question: 'Why does the chain rule apply here?', pageSlug: 'derivatives' },
      { answer: 'because f is composed with g' }, cfg, { sdkGenerate });

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('sonnet'); // prefix stripped, no leaked 'claude-sdk:'
    expect(calls[0].prompt).toContain('Why does the chain rule apply here?');
    expect(calls[0].prompt).toContain('because f is composed with g');
    expect(g.verdict).toBe('correct');
  });

  it('routes the writing_draft grader to the fake and parses its JSON-only response', async () => {
    const payload = {
      annotations: [{ span: 'the cat sat', category: 'vague', note: 'be specific' }],
      skillGrades: { claim: 'good', concision: 'weak', specificity: 'weak' },
    };
    const { calls, sdkGenerate } = fakeSdk(JSON.stringify(payload));
    const cfg = { models: { grader: { model: 'claude-sdk:opus' } } } as any;
    const g = await gradeBlockOutput('writing_draft',
      { prompt: 'Describe the cat.', round: 1, pageSlug: 'writing-1' },
      { draft: 'the cat sat' }, cfg, { sdkGenerate });

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('the cat sat');
    expect(calls[0].prompt.toLowerCase()).toContain('json');
    expect(g.verdict).toBe('reviewed');
    expect(g.annotations).toEqual(payload);
    expect(g.evidence[0].kind).toBe('struggled'); // a weak skill is present
  });

  it('throws a readable error when the claude-sdk writing_draft response is not valid JSON', async () => {
    const { sdkGenerate } = fakeSdk('not json at all');
    const cfg = { models: { grader: { model: 'claude-sdk:opus' } } } as any;
    await expect(gradeBlockOutput('writing_draft',
      { prompt: 'Describe the cat.', round: 1, pageSlug: 'writing-1' },
      { draft: 'the cat sat' }, cfg, { sdkGenerate }))
      .rejects.toThrow(/invalid JSON/i);
  });
});
