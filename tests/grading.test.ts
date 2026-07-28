import { describe, it, expect } from 'vitest';
import { extractAnswerNumber, freeVariables, gradeBlockOutput, gradeStructured, mathEquivalent } from '../src/server/grading.js';
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

  // Equations are how students actually write algebra ("2x+3=11 → 2x=8 → x=4"). mathjs reads '='
  // as ASSIGNMENT — "x=4" happened to evaluate while "2x=8" threw, so a live math_scratchpad
  // sitting saw an ordinary equation step called "unparseable" in the verdict.
  describe('equations', () => {
    it('grades an isolating equation against an expected expression', () => {
      expect(mathEquivalent('x=4', '4', 'x')).toBe(true);
      expect(mathEquivalent('x=5', '4', 'x')).toBe(false);
      expect(mathEquivalent('V=\\frac{nRT}{P}', '\\frac{nRT}{P}')).toBe(true); // isolated symbol, either side
      expect(mathEquivalent('4', 'x=4', 'x')).toBe(true);                      // symmetric
    });
    it('treats equivalent equations as the same statement (residual proportionality)', () => {
      expect(mathEquivalent('2x=8', 'x=4', 'x')).toBe(true);        // both sides halved
      expect(mathEquivalent('2x+3=11', '2x=8', 'x')).toBe(true);    // 3 subtracted from both sides
      expect(mathEquivalent('2x+3=11', 'x=4', 'x')).toBe(true);     // two legal moves at once
      expect(mathEquivalent('2x=8', 'x=5', 'x')).toBe(false);       // different solution
      expect(mathEquivalent('x^2=4', 'x=2', 'x')).toBe(false);      // two roots vs one — not the same statement
    });
    it('does not read a non-isolating equation as an expression', () => {
      expect(mathEquivalent('2x=8', '4', 'x')).toBe(false);
    });
    it('detects free variables on both sides of an equation', () => {
      expect(freeVariables('2x+3=11')).toEqual(['x']);
      expect(freeVariables('P V=nRT')).toEqual(['P', 'R', 'T', 'V', 'n']);
    });
  });
});

// structured_check — the generic applied block. `cfg = {} as any` in the suite below is the guard
// that matters: if any checker ever reached for a model it would throw on cfg.models.grader.
describe('structured_check checkers (mechanical, any subject)', () => {
  const cfg = {} as any;
  const grade = (checker: any, values: string[]) => gradeBlockOutput('structured_check',
    { prompt: 'p', pageSlug: 'topic', checker }, { values }, cfg);

  it('percent unit: a bare number satisfies it — % is formatting, not meaning', async () => {
    // A live check dinged `struggled` for "0.1" against unit '%' when the tutor's own example
    // said 'e.g. "5" for 5%'. Fraction-vs-percent confusion still fails the numeric comparison.
    const c = { kind: 'numeric', expected: 0.1, tolerance: 0.01, unit: '%' };
    expect((await grade(c, ['0.1'])).verdict).toBe('correct');     // bare number
    expect((await grade(c, ['0.1%'])).verdict).toBe('correct');    // explicit %
    expect((await grade(c, ['0.1 kg'])).verdict).toBe('partial');  // a DIFFERENT unit still flags
    expect((await grade(c, ['0.001'])).verdict).toBe('incorrect'); // fraction confusion → numeric miss
  });

  it('vector: ordered components with tolerance, any bracket notation, optional unit', async () => {
    const c = { kind: 'vector', expected: [3, 4], tolerance: 0.01 };
    expect((await grade(c, ['(3, 4)'])).verdict).toBe('correct');
    expect((await grade(c, ['3, 4'])).verdict).toBe('correct');
    expect((await grade(c, ['⟨3 4⟩'])).verdict).toBe('correct');
    expect((await grade(c, ['[3.004, 3.997]'])).verdict).toBe('correct'); // within tolerance
    // Order matters — (4, 3) is a different vector, unlike `set`.
    expect((await grade(c, ['(4, 3)'])).verdict).toBe('incorrect');
    // Wrong arity is named, not silently wrong.
    const arity = await grade(c, ['3']);
    expect(arity.verdict).toBe('incorrect');
    expect(arity.detail).toContain('expected 2 components');
    // Partial: one component right, one wrong.
    expect((await grade(c, ['(3, 9)'])).verdict).toBe('partial');
  });

  it('vector: a digit-bearing unit is not mistaken for a component', async () => {
    const c = { kind: 'vector', expected: [3, 4], tolerance: 0.01, unit: 'm/s' };
    expect((await grade(c, ['(3, 4) m/s'])).verdict).toBe('correct');
    // The "2" in "m/s2" must NOT be read as a third component.
    const c2 = { kind: 'vector', expected: [3, 4], tolerance: 0.01, unit: 'm/s^2' };
    expect((await grade(c2, ['(3, 4) m/s2'])).verdict).toBe('correct');
    // The PRINTED superscript form must satisfy the same unit — the prompt renders m/s² (KaTeX),
    // and the vector path used to fold-less-ly reject the ² the learner copied. (Regression.)
    expect((await grade(c2, ['(3, 4) m/s²'])).verdict).toBe('correct');
    expect((await grade({ kind: 'vector', expected: [0, -9.8], tolerance: 0.05, unit: 'm/s^2' },
      ['(0, -9.8) m/s²'])).verdict).toBe('correct');
    // Right components, missing unit -> partial, like numeric.
    expect((await grade(c, ['(3, 4)'])).verdict).toBe('partial');
  });

  it('vector: a component in printed scientific notation parses (E-field style)', async () => {
    const c = { kind: 'vector', expected: [3e5, 0], tolerance: 1 };
    expect((await grade(c, ['(3 × 10^5, 0)'])).verdict).toBe('correct');
    expect((await grade(c, ['(3 × 10⁵, 0)'])).verdict).toBe('correct'); // printed superscript
    expect((await grade(c, ['(5, 0)'])).verdict).not.toBe('correct');   // wrong value still fails
  });

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
  it('numeric: accepts the printed unit form the prompt itself renders', async () => {
    // Prompts show m/s² (KaTeX) and the answer preview echoes ² — a learner who types or pastes
    // that printed form must not be told the unit is wrong.
    const c = { kind: 'numeric', expected: 9.81, tolerance: 0.01, unit: 'm/s^2' };
    expect((await grade(c, ['9.81 m/s²'])).verdict).toBe('correct');
    const ohm = { kind: 'numeric', expected: 3, tolerance: 0.01, unit: 's^-1' };
    expect((await grade(ohm, ['3 s⁻¹'])).verdict).toBe('correct');
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
  it('matching: a blank row fails only itself, not the correct picks after it', async () => {
    // The block sends one pick per left item, in order, '' for an unselected row. A blank must not
    // shift the later picks up a slot and mark correct matches wrong — the learner matched a and c
    // right and left b blank, so exactly b is wrong.
    const c = { kind: 'matching', items: [
      { left: 'a', right: 'ra' }, { left: 'b', right: 'rb' }, { left: 'c', right: 'rc' },
    ] };
    const g = await grade(c, ['ra', '', 'rc']);
    expect(g.perItem).toEqual([
      { id: 'a', correct: true }, { id: 'b', correct: false }, { id: 'c', correct: true },
    ]);
    expect(g.verdict).toBe('partial'); // 2/3, and never a false 'correct'
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

  it('names an unparseable step even when the final is correct', async () => {
    // The step call-out must not vanish under a green final — only parseability is checked, and
    // hiding the miss implied the whole derivation had been read.
    const g = await gradeBlockOutput('math_scratchpad',
      { problemLatex: 'x^3-5x', stepMode: true, expectedLatex: '3x^2-5', variable: 'x', pageSlug: 'derivatives' },
      { steps: [{ latex: '3x^2-' }, { latex: '3x^2-5' }], finalLatex: '3x^2-5' }, cfg);
    expect(g.verdict).toBe('correct');
    expect(g.detail).toBe('final answer numerically equivalent; step 1 unparseable');
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
  // "submit anyway": the block lets a learner commit a red suite (completed: true with failures),
  // and wroteCode is a scaffold-diff, not a pass marker — so completed + wroteCode alone minted
  // 'applied-correctly' with the note "passed real tests" for a 1/4 submission (caught live in
  // audit 45). A red suite earns 'struggled', with the failing-case diagnosis in the note.
  it('completed + wroteCode with a failing suite ("submit anyway") -> struggled, never applied-correctly', async () => {
    const g = await gradeBlockOutput('code_exercise',
      { pattern: 'dilution-calculator', rung: 'full_body', pageSlug: 'dilution-calculator' },
      {
        completed: true, rungReached: 'full_body', testsPassed: 1, testsTotal: 4, wroteCode: true,
        failingTests: ['a simple tenfold dilution', 'rounds to 2 decimal places'],
      }, cfg);
    expect(g.verdict).toBe('incorrect');
    expect(g.evidence[0]).toMatchObject({ slug: 'dilution-calculator', kind: 'struggled' });
    expect(g.evidence[0].note).toContain('submitted with 1/4 passing');
    expect(g.evidence[0].note).toContain('still failing: a simple tenfold dilution');
    expect(g.detail).toContain('recorded as struggled — submitted with a failing suite');
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

  // pronounce — grading is client-side (audio stays local); the server mints evidence from the
  // reported outcome. `applied` requires `required` clean attempts, so no single lucky try mints
  // mastery — the "require several passes" rule.
  it('pronounce: applied (3/3 clean) -> applied-correctly', async () => {
    const g = await gradeBlockOutput('pronounce',
      { word: 'má', lang: 'vi', tone: 'sac', pageSlug: 'vietnamese-tones', requiredPasses: 3 },
      { passes: 3, required: 3, applied: true, attempts: 4 }, cfg);
    expect(g.verdict).toBe('correct');
    expect(g.evidence[0]).toMatchObject({ slug: 'vietnamese-tones', kind: 'applied-correctly' });
    expect(g.detail).toContain('3/3');
  });
  it('pronounce: some clean but short of required -> exposed, never applied-correctly', async () => {
    const g = await gradeBlockOutput('pronounce',
      { word: 'má', lang: 'vi', tone: 'sac', pageSlug: 'vietnamese-tones', requiredPasses: 3 },
      { passes: 1, required: 3, applied: false, attempts: 5 }, cfg);
    expect(g.verdict).toBe('partial');
    expect(g.evidence[0]).toMatchObject({ kind: 'exposed' });
  });
  it('pronounce: no clean attempt -> struggled', async () => {
    const g = await gradeBlockOutput('pronounce',
      { word: 'má', lang: 'vi', tone: 'sac', pageSlug: 'vietnamese-tones' },
      { passes: 0, required: 3, applied: false, attempts: 3 }, cfg);
    expect(g.evidence[0]).toMatchObject({ kind: 'struggled' });
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

  // Audit 40: a rubric'd draft used to return bare pass/fail lines — the annotation feedback
  // (marked-up spans, skill grades) was silently skipped whenever a rubric was present.
  const rubricInput = {
    prompt: 'Argue it.', round: 1, pageSlug: 'writing-1',
    rubric: ['thesis takes a side'],
  };
  const rubricJson = JSON.stringify({
    criteria: [{ criterion: 'thesis takes a side', pass: true, note: 'clear side' }],
  });
  const annJson = JSON.stringify({
    annotations: [{ span: 'the cat sat', category: 'strong', note: 'arguable' }],
    skillGrades: { claim: 'good' },
  });

  it("a rubric'd draft carries annotation feedback alongside the rubric verdict", async () => {
    const sdkGenerate = async ({ prompt }: ClaudeSdkGenerateOpts): Promise<ClaudeSdkResult> =>
      ({ text: /rubric criterion/i.test(prompt) ? rubricJson : annJson, toolCallNames: [] });
    const cfg = { models: { grader: { model: 'claude-sdk:opus' } } } as any;
    const g = await gradeBlockOutput('writing_draft', rubricInput, { draft: 'the cat sat' }, cfg, { sdkGenerate });
    expect(g.rubric).toEqual([{ criterion: 'thesis takes a side', pass: true, note: 'clear side' }]);
    expect(g.annotations?.annotations[0].span).toBe('the cat sat');
    expect(g.annotations?.skillGrades).toEqual({ claim: 'good' });
    expect(g.evidence.map((e) => e.kind)).toEqual(['rubric-passed']);
  });

  it('accepts grader JSON wrapped in a markdown fence — live sonnet does this despite the JSON-only instruction', async () => {
    const fence = (s: string) => '```json\n' + s + '\n```';
    const sdkGenerate = async ({ prompt }: ClaudeSdkGenerateOpts): Promise<ClaudeSdkResult> =>
      ({ text: fence(/rubric criterion/i.test(prompt) ? rubricJson : annJson), toolCallNames: [] });
    const cfg = { models: { grader: { model: 'claude-sdk:opus' } } } as any;
    const g = await gradeBlockOutput('writing_draft', rubricInput, { draft: 'the cat sat' }, cfg, { sdkGenerate });
    expect(g.rubric?.[0].pass).toBe(true); // a fenced rubric-judge reply must not lose the turn
    expect(g.annotations?.skillGrades).toEqual({ claim: 'good' });
  });

  it('a failed annotation call does not lose the rubric verdict, and says so', async () => {
    const sdkGenerate = async ({ prompt }: ClaudeSdkGenerateOpts): Promise<ClaudeSdkResult> => {
      if (/rubric criterion/i.test(prompt)) return { text: rubricJson, toolCallNames: [] };
      throw new Error('grader down');
    };
    const cfg = { models: { grader: { model: 'claude-sdk:opus' } } } as any;
    const g = await gradeBlockOutput('writing_draft', rubricInput, { draft: 'the cat sat' }, cfg, { sdkGenerate });
    expect(g.rubric?.[0].pass).toBe(true);
    expect(g.annotations).toBeUndefined();
    expect(g.detail).toContain('annotations unavailable');
    expect(g.evidence.map((e) => e.kind)).toEqual(['rubric-passed']);
  });
});

describe('quick_check phrasing tolerance (audit: correct answer graded wrong on wording)', () => {
  function fakeSdk2(text: string) {
    const calls: ClaudeSdkGenerateOpts[] = [];
    const sdkGenerate = async (opts: ClaudeSdkGenerateOpts): Promise<ClaudeSdkResult> => {
      calls.push(opts);
      return { text, toolCallNames: [] };
    };
    return { calls, sdkGenerate };
  }
  const input = { question: 'What must the parser hold between reads?', mode: 'text', expected: 'buffer', pageSlug: 'p' };
  const cfg = { models: { grader: { model: 'claude-sdk:sonnet' } } } as any;

  it('an exact match stays mechanical applied-correctly, no model consulted', async () => {
    const { calls, sdkGenerate } = fakeSdk2('should not be called');
    const g = await gradeBlockOutput('quick_check', input, { answer: ' Buffer ' }, cfg, { sdkGenerate });
    expect(g.source).toBe('mechanical');
    expect(g.evidence[0].kind).toBe('applied-correctly');
    expect(calls).toHaveLength(0);
  });

  it('a rephrased-but-right answer falls back to the model grader, expected passed as context', async () => {
    const { calls, sdkGenerate } = fakeSdk2('CORRECT — names the cross-read buffer');
    const g = await gradeBlockOutput('quick_check', input, { answer: 'a buffer carried across reads' }, cfg, { sdkGenerate });
    expect(g.verdict).toBe('correct');
    expect(g.source).toBe('model');
    // capApplied: a model judged it — it must not mint applied-correctly.
    expect(g.evidence[0].kind).toBe('explained-correctly');
    expect(calls[0].prompt).toContain('A correct answer conveys: buffer');
  });

  it('a wrong answer still records struggled through the fallback', async () => {
    const { sdkGenerate } = fakeSdk2('INCORRECT — that is not it');
    const g = await gradeBlockOutput('quick_check', input, { answer: 'the file descriptor' }, cfg, { sdkGenerate });
    expect(g.verdict).toBe('incorrect');
    expect(g.evidence[0].kind).toBe('struggled');
  });
});

describe('math_scratchpad step-chain break detection', () => {
  const cfg = {} as any; // fully mechanical branch — no grader model involved
  const input = { problemLatex: 'simplify', expectedLatex: '2x', variable: 'x', stepMode: true, pageSlug: 'p' };
  const grade = (steps: string[], finalLatex: string) =>
    gradeBlockOutput('math_scratchpad', input, { steps: steps.map((latex) => ({ latex })), finalLatex }, cfg, {} as any);

  it('on a wrong final, names the first non-equivalent transition between steps', async () => {
    // step1 = x+x (≡ 2x is irrelevant; chain checks ADJACENT pairs): x+x -> 3x breaks first.
    const g = await grade(['x+x', '3x'], '3x');
    expect(g.verdict).toBe('incorrect');
    expect(g.detail).toContain('breaks between steps 1 and 2');
  });

  it('names the last-step-to-final transition when that is where it breaks', async () => {
    const g = await grade(['x+x', '2x'], '5x');
    expect(g.detail).toContain('between the last step and the final answer');
  });

  it('stays silent on a correct final — non-equivalent lines are legitimate there', async () => {
    const g = await grade(['4x - 2x'], '2x');
    expect(g.verdict).toBe('correct');
    expect(g.detail).not.toContain('breaks');
  });

  // Regression from a live MathLive drive: the natural way to solve "2x+3=11" is an equation
  // chain, and every one of those steps was being called unparseable (mathjs '=' assignment).
  it('an equation-chain derivation grades clean — no unparseable call-out', async () => {
    const eqInput = { problemLatex: '2x+3=11', expectedLatex: '4', variable: 'x', stepMode: true, pageSlug: 'p' };
    const g = await gradeBlockOutput('math_scratchpad', eqInput,
      { steps: [{ latex: '2x=8' }, { latex: 'x=4' }], finalLatex: 'x=4' }, cfg, {} as any);
    expect(g.verdict).toBe('correct');
    expect(g.detail).toBe('final answer numerically equivalent');
  });

  it('locates the break inside an equation chain on a wrong final', async () => {
    const eqInput = { problemLatex: '2x+3=11', expectedLatex: '4', variable: 'x', stepMode: true, pageSlug: 'p' };
    const g = await gradeBlockOutput('math_scratchpad', eqInput,
      { steps: [{ latex: '2x=8' }, { latex: 'x=5' }], finalLatex: 'x=5' }, cfg, {} as any);
    expect(g.verdict).toBe('incorrect');
    expect(g.detail).toContain('breaks between steps 1 and 2');
  });
});

// A live session-plan sitting answered a numeric check with its full derivation and was told
// "no number found in the answer" — parseLeadingNumber anchors at the start, and showing your
// work must never read as not answering. extractAnswerNumber's ladder: leading, then after the
// last '=', then a lone number token; genuinely ambiguous stays NaN.
describe('extractAnswerNumber — the number a free-text answer means', () => {
  it('a derivation ending in the final answer', () => {
    expect(extractAnswerNumber('C = 1/2 (1 - 0.8)^2 = 1/2 (0.2)^2 = 0.02')).toBe(0.02);
    expect(extractAnswerNumber('x = 4')).toBe(4);
  });
  it('leading-number fast path unchanged (unit exponents stay ignored)', () => {
    expect(extractAnswerNumber('9.81 m/s^2')).toBe(9.81);
    expect(extractAnswerNumber('1,024')).toBe(1024);
  });
  it('reads scientific notation written the printed way, not just e-notation', () => {
    // Avogadro/electron-charge/light-speed style answers — a chem or physics learner writes
    // "6.02 × 10^23", not "6.02e23", and the checker used to grade that as 6.02 (off by 10^23).
    expect(extractAnswerNumber('6.02e23')).toBe(6.02e23);
    expect(extractAnswerNumber('6.02 × 10^23')).toBe(6.02e23);
    expect(extractAnswerNumber('6.02 x 10^23')).toBe(6.02e23);
    expect(extractAnswerNumber('6.02 × 10²³')).toBe(6.02e23);       // printed superscript
    expect(extractAnswerNumber('1.6 × 10⁻¹⁹')).toBe(1.6e-19);       // negative superscript exponent
    expect(extractAnswerNumber('C = 3 × 10^8')).toBe(3e8);          // sci-notation after a derivation's =
    // "× 10^n" is scientific notation; a unit exponent (no "× 10") must stay ignored.
    expect(extractAnswerNumber('9.81 m/s^2')).toBe(9.81);
  });
  it('reads a leading fraction as its quotient (probabilities, coefficients, exact ratios)', () => {
    expect(extractAnswerNumber('1/2')).toBe(0.5);
    expect(extractAnswerNumber('3/4')).toBe(0.75);
    expect(extractAnswerNumber('-3/4')).toBe(-0.75);
    expect(extractAnswerNumber('1 / 2')).toBe(0.5);
    expect(extractAnswerNumber('3/4 m')).toBe(0.75);          // fraction then a unit
    expect(extractAnswerNumber('22/7')).toBeCloseTo(3.142857, 5);
    // A unit with a slash is NOT a fraction — letters around the slash, so it stays the leading value.
    expect(extractAnswerNumber('9.81 m/s^2')).toBe(9.81);
  });
  it('reads unicode vulgar fractions and mixed numbers', () => {
    expect(extractAnswerNumber('½')).toBe(0.5);
    expect(extractAnswerNumber('¾')).toBe(0.75);
    expect(extractAnswerNumber('⅓')).toBeCloseTo(1 / 3, 12);
    expect(extractAnswerNumber('1½')).toBe(1.5);       // mixed number, glyph
    expect(extractAnswerNumber('1 1/2')).toBe(1.5);    // mixed number, typed
    expect(extractAnswerNumber('2¾')).toBe(2.75);
    expect(extractAnswerNumber('-1½')).toBe(-1.5);     // negative mixed number
  });
  it('a lone number anywhere in prose', () => {
    expect(extractAnswerNumber('about 0.02')).toBe(0.02);
    expect(extractAnswerNumber('answer: 42')).toBe(42);
  });
  it('ambiguity stays NaN rather than guessing', () => {
    expect(Number.isNaN(extractAnswerNumber('between 3 and 5'))).toBe(true);
    expect(Number.isNaN(extractAnswerNumber('no idea'))).toBe(true);
  });
  it('gradeStructured accepts a shown-work numeric answer end to end', () => {
    const g = gradeStructured({ kind: 'numeric', expected: 0.02 }, ['C = 1/2 (1 - 0.8)^2 = 0.02']);
    expect(g.allCorrect).toBe(true);
  });
});

// A live revision round lost a rubric point to "the grader did not address this criterion" when
// the verdict actually existed under a paraphrased name — and a genuine omission cost a point to
// grader laziness. Same-length replies now zip by index (the prompt enumerates); true omissions
// get one narrowed retry; anything still unanswered keeps the fail-closed verdict.
describe('rubric judging — paraphrase tolerance and the omission retry', () => {
  const cfg = { models: { grader: { model: 'claude-sdk:opus' } } } as any;
  const twoCriteria = {
    prompt: 'Explain it.', round: 1, pageSlug: 'writing-1',
    rubric: ['states the mechanism accurately', 'gives an intuitive reason why'],
  };
  const annJson = JSON.stringify({ annotations: [], skillGrades: { claim: 'good' } });

  it('a same-length reply with paraphrased names matches by index', async () => {
    const judged = JSON.stringify({ criteria: [
      { criterion: 'mechanism correctness', pass: true, note: 'right' },
      { criterion: 'intuition provided', pass: true, note: 'clock hands' },
    ] });
    const sdkGenerate = async ({ prompt }: ClaudeSdkGenerateOpts): Promise<ClaudeSdkResult> =>
      ({ text: /rubric criterion/i.test(prompt) ? judged : annJson, toolCallNames: [] });
    const g = await gradeBlockOutput('writing_draft', twoCriteria, { draft: 'd' }, cfg, { sdkGenerate });
    expect(g.rubric?.map((r: any) => r.pass)).toEqual([true, true]);
    expect(g.evidence.map((e) => e.kind)).toEqual(['rubric-passed']);
  });

  it('an omitted criterion gets one narrowed retry, and the retry verdict lands', async () => {
    const rubricCalls: string[] = [];
    const sdkGenerate = async ({ prompt }: ClaudeSdkGenerateOpts): Promise<ClaudeSdkResult> => {
      if (!/rubric criterion/i.test(prompt)) return { text: annJson, toolCallNames: [] };
      rubricCalls.push(prompt);
      // First call: answers only criterion 1. Retry (names only the missing one): answers it.
      const first = rubricCalls.length === 1;
      return {
        text: JSON.stringify({ criteria: first
          ? [{ criterion: 'states the mechanism accurately', pass: true, note: 'right' }]
          : [{ criterion: 'gives an intuitive reason why', pass: false, note: 'no intuition offered' }] }),
        toolCallNames: [],
      };
    };
    const g = await gradeBlockOutput('writing_draft', twoCriteria, { draft: 'd' }, cfg, { sdkGenerate });
    expect(rubricCalls).toHaveLength(2);
    expect(rubricCalls[1]).toContain('gives an intuitive reason why');
    expect(rubricCalls[1]).not.toContain('states the mechanism accurately');
    expect(g.rubric?.[1]).toEqual({ criterion: 'gives an intuitive reason why', pass: false, note: 'no intuition offered' });
  });

  it('a retry that fails leaves the fail-closed verdict standing', async () => {
    let rubricCalls = 0;
    const sdkGenerate = async ({ prompt }: ClaudeSdkGenerateOpts): Promise<ClaudeSdkResult> => {
      if (!/rubric criterion/i.test(prompt)) return { text: annJson, toolCallNames: [] };
      rubricCalls++;
      if (rubricCalls === 1) {
        return { text: JSON.stringify({ criteria: [{ criterion: 'states the mechanism accurately', pass: true, note: 'right' }] }), toolCallNames: [] };
      }
      return { text: 'not json', toolCallNames: [] };
    };
    const g = await gradeBlockOutput('writing_draft', twoCriteria, { draft: 'd' }, cfg, { sdkGenerate });
    expect(g.rubric?.[1].pass).toBe(false);
    expect(g.rubric?.[1].note).toMatch(/did not address/);
  });
});
