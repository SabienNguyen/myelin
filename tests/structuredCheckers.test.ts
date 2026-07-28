// The three domain checkers of backlog item 1 — the ones that let a physics, chemistry or music
// learner earn applied-correctly (and therefore `mastered`) from a machine's verdict.
//
// Every checker is tested in BOTH directions. An accept-only test would pass for `return true`,
// and these checkers exist precisely so that a wrong answer is mechanically refused.

import { describe, it, expect } from 'vitest';
import {
  gradeUnitAnswer, gradeChemEquation, gradeNotes, parseFormula, parseNote,
} from '../src/server/structuredCheckers.js';
import { gradeStructured } from '../src/server/grading.js';

describe('unit — quantity equivalence, not digit equality', () => {
  const twentyMs = { expected: 20, unit: 'm/s' };

  it('accepts the same quantity written in a different unit', () => {
    // The reason this checker exists: the plain numeric checker marked these wrong.
    expect(gradeUnitAnswer('72 km/h', twentyMs).ok).toBe(true);
    expect(gradeUnitAnswer('20 m/s', twentyMs).ok).toBe(true);
    expect(gradeUnitAnswer('1 N·m', { expected: 1, unit: 'J' }).ok).toBe(true);
    expect(gradeUnitAnswer('1000 mJ', { expected: 1, unit: 'J' }).ok).toBe(true);
  });

  it('accepts scientific notation written the printed way (3 × 10^8 m/s), not just e-notation', () => {
    const c = { expected: 3e8, unit: 'm/s' }; // speed of light
    expect(gradeUnitAnswer('3 × 10^8 m/s', c).ok).toBe(true);
    expect(gradeUnitAnswer('3 × 10⁸ m/s', c).ok).toBe(true);   // printed superscript
    expect(gradeUnitAnswer('3 x 10^8 m/s', c).ok).toBe(true);  // ascii 'x' times sign
    expect(gradeUnitAnswer('3e8 m/s', c).ok).toBe(true);
    expect(gradeUnitAnswer('20 m/s', c).ok).toBe(false);       // a wrong value still fails
  });

  it('accepts superscript exponents in the printed form — s⁻¹ is Hz, m⁻² a per-area', () => {
    // The rendered unit uses superscripts; a learner who copies "10 s⁻¹" must grade the same as
    // one who types "10 s^-1". Previously only ²/³ folded, so negative and higher powers failed.
    expect(gradeUnitAnswer('10 s⁻¹', { expected: 10, unit: 'Hz' }).ok).toBe(true);
    expect(gradeUnitAnswer('10 Hz', { expected: 10, unit: 's⁻¹' }).ok).toBe(true);
    expect(gradeUnitAnswer('5 kg·m⁻³', { expected: 5, unit: 'kg/m^3' }).ok).toBe(true);
  });

  it('rejects the right digits in the wrong unit — 20 km/h is not 20 m/s', () => {
    const v = gradeUnitAnswer('20 km/h', twentyMs);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/reads as/);
  });

  it('rejects a dimensionally different answer instead of comparing nonsense', () => {
    const v = gradeUnitAnswer('20 s', twentyMs);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/not a quantity of m\/s/);
  });

  it('rejects an answer with no readable unit, naming the problem', () => {
    expect(gradeUnitAnswer('twenty', twentyMs).ok).toBe(false);
  });

  it('holds tolerance: honest rounding passes, a different answer does not', () => {
    expect(gradeUnitAnswer('19.99 m/s', twentyMs).ok).toBe(true);   // 0.05% off
    expect(gradeUnitAnswer('21 m/s', twentyMs).ok).toBe(false);     // 5% off
  });

  it('reads learner typography: · × ² and thousands separators', () => {
    expect(gradeUnitAnswer('9.81 m/s²', { expected: 9.81, unit: 'm/s^2' }).ok).toBe(true);
    expect(gradeUnitAnswer('1,000 J', { expected: 1, unit: 'kJ' }).ok).toBe(true);
  });
});

describe('chem_equation — conservation per element and per charge', () => {
  it('parses real formulas', () => {
    expect(parseFormula('Ca(OH)2')).toEqual({ Ca: 1, O: 2, H: 2 });
    expect(parseFormula('C6H12O6')).toEqual({ C: 6, H: 12, O: 6 });
  });

  it('accepts a correctly balanced equation', () => {
    expect(gradeChemEquation('CH4 + 2O2 -> CO2 + 2H2O', {}).ok).toBe(true);
    expect(gradeChemEquation('2H2 + O2 → 2H2O', {}).ok).toBe(true);
  });

  it('ignores state symbols (g)/(l)/(s)/(aq) — they annotate phase, not balance', () => {
    // Every textbook equation carries these; they must not turn a correct answer into a parse error.
    expect(gradeChemEquation('2H2(g) + O2(g) -> 2H2O(l)', {}).ok).toBe(true);
    expect(gradeChemEquation('NaCl(s) -> Na+(aq) + Cl-(aq)', {}).ok).toBe(true);
    // A real multiplier group Ca(OH)2 is NOT a state symbol and stays intact.
    expect(gradeChemEquation('Ca(OH)2 -> Ca^2+ + 2OH-', {}).ok).toBe(true);
    // …and an unbalanced equation is still caught, state symbols or not.
    expect(gradeChemEquation('H2(g) + O2(g) -> H2O(g)', {}).ok).toBe(false);
  });

  it('accepts the equilibrium arrow and common variants — balancing is arrow-agnostic', () => {
    // A chemistry learner balancing an equilibrium writes ⇌ (or an ASCII form); balancing both
    // sides is identical to a one-way reaction, so these must not be turned away as "no arrow".
    expect(gradeChemEquation('N2 + 3H2 ⇌ 2NH3', {}).ok).toBe(true);
    expect(gradeChemEquation('N2 + 3H2 <=> 2NH3', {}).ok).toBe(true);
    expect(gradeChemEquation('N2 + 3H2 <-> 2NH3', {}).ok).toBe(true);
    // Still exactly one arrow required: two of them is an error, not a three-way split.
    expect(gradeChemEquation('N2 ⇌ H2 ⇌ NH3', {}).ok).toBe(false);
  });

  it('rejects an unbalanced equation and names the element, never the count', () => {
    const v = gradeChemEquation('CH4 + O2 -> CO2 + H2O', {});
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/[HO]/);        // names what is off…
    expect(v.detail).not.toMatch(/\d\/\d/);  // …without handing over the arithmetic
  });

  it('conserves charge, not just atoms', () => {
    expect(gradeChemEquation('Fe^2+ -> Fe^3+ + e-', {}).ok).toBe(true);
    expect(gradeChemEquation('Fe^2+ -> Fe^3+', {}).ok).toBe(false);
  });

  it('reads the printed ion form — subscript counts (H₂O) and superscript charges (Fe²⁺)', () => {
    // How ions appear in a textbook or a rendered equation the learner copies; the ASCII form works
    // too, so both must grade the same.
    expect(gradeChemEquation('Fe²⁺ -> Fe³⁺ + e-', {}).ok).toBe(true);
    expect(gradeChemEquation('2H₂ + O₂ -> 2H₂O', {}).ok).toBe(true);
    expect(gradeChemEquation('Ca²⁺ + 2OH⁻ -> Ca(OH)₂', {}).ok).toBe(true);
    // superscript charge + state symbols together, and an unbalanced charge still caught.
    expect(gradeChemEquation('NaCl(s) -> Na⁺(aq) + Cl⁻(aq)', {}).ok).toBe(true);
    expect(gradeChemEquation('Fe²⁺ -> Fe³⁺', {}).ok).toBe(false);
  });

  it('refuses a DIFFERENT balanced equation when the reaction is pinned', () => {
    // "H2 + H2 -> 2H2" is balanced; without the species pin it would grade as chemistry.
    const pin = { reactants: ['CH4', 'O2'], products: ['CO2', 'H2O'] };
    expect(gradeChemEquation('2H2 + O2 -> 2H2O', pin).ok).toBe(false);
    expect(gradeChemEquation('CH4 + 2O2 -> CO2 + 2H2O', pin).ok).toBe(true);
  });

  it('reads gibberish as a parse problem, not a crash', () => {
    expect(gradeChemEquation('the mitochondria', {}).ok).toBe(false);
    expect(gradeChemEquation('CH4 + O2', {}).ok).toBe(false); // no arrow
  });

  it('refuses cramped plus signs with instructions rather than mis-reading an ion', () => {
    // "Fe^3++e-" is genuinely ambiguous with charges around; a one-sided-space rule split
    // "Fe^3+ + e-" AT THE CHARGE. The parser demands spaces and says so.
    const v = gradeChemEquation('CH4+2O2 -> CO2 + 2H2O', {});
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/space on both sides/);
  });
});

describe('notes — pitch arithmetic, enharmonic-aware', () => {
  it('parses accidentals and octaves', () => {
    expect(parseNote('C#4').absolute).toBe(parseNote('Db4').absolute);
    expect(parseNote('Bb').pc).toBe(10);
    expect(parseNote('E').pc).toBe(4);
  });

  it('accepts the natural sign — "F♮" is plain F, not a parse error', () => {
    expect(parseNote('F♮').pc).toBe(parseNote('F').pc);
    expect(gradeNotes(['F♮'], { expected: ['F'] }).ok).toBe(true);
  });

  it('accepts either enharmonic spelling — C# names the same key as Db', () => {
    const majorThirdAboveB = { expected: ['D#'] };
    expect(gradeNotes(['D#'], majorThirdAboveB).ok).toBe(true);
    expect(gradeNotes(['Eb'], majorThirdAboveB).ok).toBe(true);
  });

  it('accepts the flat spelling of the same pitch', () => {
    expect(gradeNotes(['Eb'], { expected: ['D#'] }).ok).toBe(true); // Eb IS enharmonic to D#
  });

  it('actually rejects a wrong pitch', () => {
    expect(gradeNotes(['D'], { expected: ['D#'] }).ok).toBe(false);
  });

  it('grades a chord spelling as a set, a scale as a sequence', () => {
    const cMajor = { expected: ['C', 'E', 'G'] };
    expect(gradeNotes(['G', 'C', 'E'], cMajor).ok).toBe(true);          // any order
    expect(gradeNotes(['C', 'E'], cMajor).ok).toBe(false);              // missing one
    expect(gradeNotes(['C', 'E', 'G', 'B'], cMajor).ok).toBe(false);    // extra one
    const scale = { expected: ['C', 'D', 'E'], ordered: true };
    expect(gradeNotes(['C', 'D', 'E'], scale).ok).toBe(true);
    expect(gradeNotes(['E', 'D', 'C'], scale).ok).toBe(false);          // order was the exercise
  });

  it('compares octaves only when the expected note carries one', () => {
    expect(gradeNotes(['E5'], { expected: ['E'] }).ok).toBe(true);   // any octave asked, any given
    expect(gradeNotes(['E5'], { expected: ['E4'] }).ok).toBe(false); // specific octave asked
    expect(gradeNotes(['E4'], { expected: ['E4'] }).ok).toBe(true);
  });

  it('refuses non-notes with the offending token named', () => {
    const v = gradeNotes(['H'], { expected: ['B'] });
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('H');
  });

  // An enharmonic that crosses the octave boundary: B#4 IS C5 and Cb4 IS B3 — the accidental pushes
  // the pitch into the next octave. This works only because parseNote keeps the RAW (un-mod-12)
  // pitch in `absolute`, so B#4 computes as 72 (C5), not 71 (B4). A "simplify to pitch-class first"
  // refactor would silently reject a correct answer here; this pins that it must not.
  it('an octave-crossing enharmonic matches the octave it actually sounds in (B#4 = C5, Cb4 = B3)', () => {
    expect(gradeNotes(['B#4'], { expected: ['C5'], ordered: true }).ok).toBe(true);
    expect(gradeNotes(['Cb4'], { expected: ['B3'], ordered: true }).ok).toBe(true);
    // and it does NOT collapse the octave: B#4 is C5, not C4.
    expect(gradeNotes(['B#4'], { expected: ['C4'], ordered: true }).ok).toBe(false);
  });
});

describe('through gradeStructured, where the block actually calls them', () => {
  it('unit and chem_equation take the single input; notes splits it', () => {
    expect(gradeStructured({ kind: 'unit', expected: 20, unit: 'm/s' }, ['72 km/h']).allCorrect).toBe(true);
    expect(gradeStructured({ kind: 'chem_equation' }, ['2H2 + O2 -> 2H2O']).allCorrect).toBe(true);
    expect(gradeStructured({ kind: 'notes', expected: ['C', 'E', 'G'] }, ['C, E, G']).allCorrect).toBe(true);
    expect(gradeStructured({ kind: 'notes', expected: ['C', 'E', 'G'] }, ['C E Gb']).allCorrect).toBe(false);
  });
});
