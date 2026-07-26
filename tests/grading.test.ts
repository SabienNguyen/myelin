import { describe, it, expect } from 'vitest';
import { mathEquivalent, freeVariables, gradeBlockOutput } from '../src/server/grading.js';
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

  // Multivariate (learn-anything pass): single-variable-only capped applied maths evidence at
  // one-unknown algebra, excluding physics/stats/engineering.
  describe('multivariate', () => {
    // THE correctness question in >1 dimension. If every variable were assigned the same value per
    // sample point, x+y and 2x would agree everywhere and a wrong answer would grade correct.
    it('does not confuse x+y with 2x (decorrelated sampling)', () => {
      expect(mathEquivalent('x+y', '2x')).toBe(false);
      expect(mathEquivalent('x\\cdot y', 'x+y')).toBe(false);
      expect(mathEquivalent('a-b', 'b-a')).toBe(false);
      expect(mathEquivalent('\\frac{a}{b}', '\\frac{b}{a}')).toBe(false);
    });
    it('accepts genuinely equal multivariate forms', () => {
      expect(mathEquivalent('x+y', 'y+x')).toBe(true);
      expect(mathEquivalent('x\\cdot y', 'y\\cdot x')).toBe(true);
      expect(mathEquivalent('a\\cdot b\\cdot c', 'c\\cdot b\\cdot a')).toBe(true);
      expect(mathEquivalent('\\left(x+y\\right)^{2}', 'x^{2}+2\\cdot x\\cdot y+y^{2}')).toBe(true);
      expect(mathEquivalent('\\sqrt{x^{2}+y^{2}}', '\\sqrt{y^{2}+x^{2}}')).toBe(true);
    });
    it('grades real formulas without the caller naming the variables', () => {
      expect(mathEquivalent('\\frac{nRT}{P}', '\\frac{nRT}{P}')).toBe(true);   // ideal gas, 4 vars
      expect(mathEquivalent('\\frac{nRT}{P}', 'nRTP')).toBe(false);            // P on the wrong side
      expect(mathEquivalent('\\frac{1}{2}m v^{2}', '0.5m v^{2}')).toBe(true);  // kinetic energy
    });
    it('detects free variables, excluding function names and constants', () => {
      expect(freeVariables('\\frac{nRT}{P}')).toEqual(['P', 'R', 'T', 'n']);
      expect(freeVariables('\\sin(x)+y')).toEqual(['x', 'y']);   // not 'sin'
      expect(freeVariables('\\pi r^{2}')).toEqual(['r']);        // not 'pi'
    });
    it('stays backward compatible with a single declared variable', () => {
      expect(mathEquivalent('2x', 'x+x', 'x')).toBe(true);
      expect(mathEquivalent('x^2', 'x^3', 'x')).toBe(false);
    });
  });

  // Regression: \div is on MathLive's keypad and converts to AsciiMath's `-:`, which math.compile
  // threw on — so mathEquivalent returned false and a CORRECT answer was graded wrong.
  it('accepts \\div as division', () => {
    expect(mathEquivalent('x\\div y', '\\frac{x}{y}')).toBe(true);
    expect(mathEquivalent('6\\div 2', '3')).toBe(true);
    expect(mathEquivalent('x\\div y', '\\frac{y}{x}')).toBe(false);
  });
  it('handles ln via rewrite', () => {
    expect(mathEquivalent('\\ln(x)', '\\ln(x)', 'x')).toBe(true);
  });
});

// structured_check — the generic applied block. `cfg = {} as any` in the suite below is the guard
// that matters: if any checker ever reached for a model it would throw on cfg.models.grader.
describe('structured_check checkers (mechanical, any subject)', () => {
  const cfg = {} as any;
  const grade = (checker: any, values: string[]) => gradeBlockOutput('structured_check',
    { prompt: 'p', pageSlug: 'topic', checker }, { values }, cfg);

  it('numeric: tolerance, units, and non-numeric input', async () => {
    const c = { kind: 'numeric', expected: 9.81, tolerance: 0.01, unit: 'm/s^2' };
    expect((await grade(c, ['9.81 m/s^2'])).verdict).toBe('correct');
    expect((await grade(c, ['9.807 m/s2'])).verdict).toBe('correct');   // unit spelling normalised
    // Right value, missing unit -> partial, not incorrect: the computation WAS done, and the detail
    // names what is missing. Evidence still caps at 'struggled' (see the applied-correctly test
    // below), so partial credit never becomes mastery.
    const noUnit = await grade(c, ['9.81']);
    expect(noUnit.verdict).toBe('partial');
    expect(noUnit.detail).toContain('unit should be m/s^2');
    expect(noUnit.evidence[0]).toMatchObject({ kind: 'struggled' });
    expect((await grade(c, ['12 m/s^2'])).verdict).toBe('incorrect'); // wrong value -> nothing right
    const nan = await grade(c, ['about ten']);
    expect(nan.verdict).toBe('incorrect');
    expect(nan.detail).toContain('no number');
  });
  it('numeric: relative tolerance handles large magnitudes', async () => {
    const c = { kind: 'numeric', expected: 6.022e23, tolerance: 1e-3, relative: true };
    expect((await grade(c, ['6.022e23'])).verdict).toBe('correct');
    expect((await grade(c, ['6.1e23'])).verdict).toBe('incorrect');
  });
  it('numeric: parses thousands separators and trailing units', async () => {
    const c = { kind: 'numeric', expected: 1024, tolerance: 0.5 };
    expect((await grade(c, ['1,024'])).verdict).toBe('correct');
  });
  it('set: order-insensitive, penalises extras and duplicates', async () => {
    const c = { kind: 'set', expected: ['fluorine', 'chlorine', 'bromine'] };
    expect((await grade(c, ['Bromine', 'fluorine', 'CHLORINE'])).verdict).toBe('correct');
    const partial = await grade(c, ['fluorine']);
    expect(partial.verdict).toBe('partial');
    expect(partial.detail).toBe('1/3 correct');
    const extra = await grade(c, ['fluorine', 'chlorine', 'bromine', 'sodium']);
    expect(extra.verdict).toBe('partial');           // coverage complete but a wrong one was added
    expect(extra.detail).toContain('not on the list');
    const dupe = await grade(c, ['fluorine', 'fluorine', 'fluorine']);
    expect(dupe.verdict).toBe('partial');            // duplication is not coverage
  });
  it('sequence: order is graded, not just membership', async () => {
    const c = { kind: 'sequence', expected: ['a', 'b', 'c'] };
    expect((await grade(c, ['a', 'b', 'c'])).verdict).toBe('correct');
    const scrambled = await grade(c, ['c', 'b', 'a']);
    expect(scrambled.verdict).toBe('partial');       // 'b' alone is in position
    expect(scrambled.detail).toBe('1/3 in the right position');
  });
  it('matching: per-item, keyed by the left label', async () => {
    const c = { kind: 'matching', items: [
      { left: 'tonic', right: 'I' }, { left: 'dominant', right: 'V' },
    ] };
    expect((await grade(c, ['I', 'V'])).verdict).toBe('correct');
    const half = await grade(c, ['I', 'IV']);
    expect(half.verdict).toBe('partial');
    expect(half.perItem).toEqual([{ id: 'tonic', correct: true }, { id: 'dominant', correct: false }]);
  });
  it('pattern: normalises case, spacing and stray quotes', async () => {
    const c = { kind: 'pattern', expected: 'sodium chloride' };
    expect((await grade(c, ['  Sodium   Chloride '])).verdict).toBe('correct');
    expect((await grade(c, ['"sodium chloride"'])).verdict).toBe('correct');
    expect((await grade(c, ['potassium chloride'])).verdict).toBe('incorrect');
  });
  it('full pass earns applied-correctly; anything less is struggled', async () => {
    const c = { kind: 'set', expected: ['x', 'y'] };
    expect((await grade(c, ['x', 'y'])).evidence[0]).toMatchObject({ slug: 'topic', kind: 'applied-correctly' });
    expect((await grade(c, ['x'])).evidence[0]).toMatchObject({ kind: 'struggled' });
    expect((await grade(c, [])).evidence[0]).toMatchObject({ kind: 'struggled' });
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
    // `detail` names the evidence, not the test count — the graded card already renders
    // "8/8 tests" one line above, and repeating it left nothing saying what was earned.
    expect(g.detail).toBe('recorded as applied-correctly');
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
    // The cap was previously invisible to the learner: a green 8/8 card, no hint that the run
    // could not mint applied-correctly. `detail` is the line that now says so — and it reaches
    // the tutor too, via session.ts appending every grade's verdict + detail to the thread.
    expect(g.detail).toBe(
      'recorded as exposed — expected values were revealed, so this cannot count as applying the pattern');
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
    // Distinguishable from the reveal-capped exposed above: same evidence kind, different reason,
    // and the learner needs to know which one they got.
    expect(g.detail).toBe('recorded as exposed — guided rungs only, no code of your own was graded');
  });
  it('!completed (abandoned via "stop here") -> struggled', async () => {
    const g = await gradeBlockOutput('code_exercise',
      { pattern: 'stream-consumer', rung: 'ladder', pageSlug: 'stream-consumer' },
      { completed: false, rungReached: 'full_body', testsPassed: 3, testsTotal: 8, wroteCode: false }, cfg);
    expect(g.verdict).toBe('incorrect');
    expect(g.detail).toBe('recorded as struggled — stopped at full_body');
    expect(g.evidence[0]).toMatchObject({ slug: 'stream-consumer', kind: 'struggled' });
  });

  it('failing-case NAMES ride into the struggled note and detail — a diagnosis, not a score', async () => {
    const g = await gradeBlockOutput('code_exercise',
      { pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' },
      {
        completed: false, rungReached: 'full_body', testsPassed: 3, testsTotal: 5, wroteCode: true,
        failingTests: ['single event split across two chunks', 'multi-byte UTF-8 character split across chunks'],
      }, cfg);
    expect(g.evidence[0].note).toContain('still failing: single event split across two chunks; multi-byte UTF-8 character split across chunks');
    expect(g.detail).toContain('still failing:');
  });

  it('a wide miss stays a readable note: capped at three names plus a count', async () => {
    const g = await gradeBlockOutput('code_exercise',
      { pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' },
      {
        completed: false, rungReached: 'full_body', testsPassed: 0, testsTotal: 5, wroteCode: true,
        failingTests: ['a', 'b', 'c', 'd', 'e'],
      }, cfg);
    expect(g.evidence[0].note).toContain('a; b; c (+2 more)');
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
