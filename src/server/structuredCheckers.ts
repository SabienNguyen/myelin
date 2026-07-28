// The three domain checkers that widen structured_check beyond generic comparison — backlog item 1,
// the one that moves the goal itself. Each unlocks real applied evidence (and therefore `mastered`)
// for a whole subject, with no hand-authored content per exercise:
//
//   * `unit`          — physics/chemistry/engineering answers where the learner's unit is
//                       EQUIVALENT but not identical. "1 J" and "1 N·m" and "1000 mJ" are the same
//                       answer; the plain numeric checker marked two of them wrong.
//   * `chem_equation` — a balanced chemical equation, checked by conservation per element and per
//                       charge. Entirely deterministic; makes chemistry a first-class applied subject.
//   * `notes`         — note names checked by semitone arithmetic, so C# and Db are the same pitch.
//                       The subject most obviously served by a checker nobody would think to write.
//
// Everything here is arithmetic. No model is consulted, which is what lets the resulting evidence
// be 'applied-correctly' under grading.ts's capApplied rule.

import { unit as mathUnit } from 'mathjs';

interface CheckerVerdict { ok: boolean; detail: string }

// ── unit: quantity equivalence via real unit algebra ───────────────────────────────────────────

/** Rewrite scientific notation written the printed way — "3 × 10^8", "3 × 10⁸", "1.6 x 10^-19" —
 *  into the e-notation both Number() and mathjs understand ("3e8"). Shared by the numeric checker
 *  (grading.ts imports this) and the unit checker below; lives here because this file is a leaf and
 *  grading.ts already depends on it. Deliberately narrow: only the mantissa×10^exp shape, and "10"
 *  must be the whole base ((?!\d)), so a unit exponent like "m/s^2" (no "× 10") is left alone. */
export function normalizeSciNotation(s: string): string {
  return s.replace(
    /([+-]?\d*\.?\d+)\s*[×xX*·∙]\s*10(?!\d)\s*\^?\s*([+-]?\d+|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+)/g,
    (_, mantissa: string, exp: string) => {
      const e = exp.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]/g, (c) => '0123456789+-'['⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻'.indexOf(c)]);
      return `${mantissa}e${e}`;
    },
  );
}

/** Learner-typed quantities arrive with typography mathjs does not speak. */
function normalizeQuantity(s: string): string {
  // Scientific notation FIRST, into e-notation: mathjs parses "3e8 m/s" but rejects "3 * 10^8 m/s",
  // so this must run before the ×→* rewrite below consumes the "×". Otherwise a physics answer of
  // "3 × 10^8 m/s" for the speed of light could not be read as a quantity at all.
  return normalizeSciNotation(s.trim())
    .replace(/[·×]/g, '*')
    // Superscript exponents in the printed form → caret notation mathjs parses. The old two-line
    // version only caught ² and ³; this also folds s⁻¹ (inverse second — dimensionally Hz), m⁻²,
    // and powers above 3, so a learner who copies the rendered unit grades the same as one who
    // types "^". Runs fold together: "⁻¹" → "^-1".
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+/g, (sup) =>
      `^${[...sup].map((c) => '0123456789+-'['⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻'.indexOf(c)]).join('')}`)
    .replace(/μ/g, 'u') // micro sign vs mathjs's 'u' prefix
    .replace(/,(?=\d{3}\b)/g, '');
}

/**
 * "Is the learner's quantity the same PHYSICAL quantity as expected?" — not the same digits.
 * mathjs does the dimensional algebra: `1 N*m` converts to J, `72 km/h` converts to m/s, and a
 * dimensionally wrong answer (seconds where joules were asked) fails in `to()` rather than being
 * numerically compared to nonsense.
 */
export function gradeUnitAnswer(
  answer: string,
  checker: { expected: number; unit: string; tolerance?: number; relative?: boolean },
): CheckerVerdict {
  let got;
  try {
    got = mathUnit(normalizeQuantity(answer));
  } catch {
    return { ok: false, detail: `could not read “${answer.trim()}” as a quantity with a unit` };
  }
  let inExpectedUnits: number;
  try {
    inExpectedUnits = got.toNumber(normalizeQuantity(checker.unit));
  } catch {
    return { ok: false, detail: `“${got.toString()}” is not a quantity of ${checker.unit}` };
  }
  // Relative by default, unlike the plain numeric checker: unit conversion multiplies magnitudes
  // (72 km/h is 20 m/s; 0.5 GJ is 5e8 J), so a fixed absolute tolerance is wrong at one end or the
  // other. 0.5% absorbs honest rounding without accepting a different answer.
  const tol = checker.tolerance ?? 0.005;
  const limit = checker.relative === false ? tol : Math.abs(checker.expected) * tol;
  const ok = Math.abs(inExpectedUnits - checker.expected) <= limit;
  return {
    ok,
    detail: ok
      ? `equivalent to ${checker.expected} ${checker.unit}`
      : `reads as ${Number(inExpectedUnits.toPrecision(6))} ${checker.unit}; expected ${checker.expected} ${checker.unit}`,
  };
}

// ── chem_equation: conservation per element and per charge ─────────────────────────────────────

export interface Species { coeff: number; counts: Record<string, number>; charge: number; formula: string }

/** `Ca(OH)2` -> { Ca: 1, O: 2, H: 2 }. Recursive-descent over element symbols and parens. */
export function parseFormula(formula: string): Record<string, number> {
  let i = 0;
  function group(): Record<string, number> {
    const counts: Record<string, number> = {};
    while (i < formula.length) {
      const c = formula[i];
      if (c === '(') {
        i++;
        const inner = group();
        if (formula[i] !== ')') throw new Error('unclosed parenthesis');
        i++;
        const n = readNumber() ?? 1;
        for (const [el, k] of Object.entries(inner)) counts[el] = (counts[el] ?? 0) + k * n;
      } else if (c === ')') {
        return counts;
      } else if (/[A-Z]/.test(c)) {
        let sym = c; i++;
        if (i < formula.length && /[a-z]/.test(formula[i])) { sym += formula[i]; i++; }
        const n = readNumber() ?? 1;
        counts[sym] = (counts[sym] ?? 0) + n;
      } else if (c === '+') {
        throw new Error('write a space on both sides of + between species');
      } else {
        throw new Error(`unexpected character “${c}”`);
      }
    }
    return counts;
  }
  function readNumber(): number | null {
    let digits = '';
    while (i < formula.length && /\d/.test(formula[i])) { digits += formula[i]; i++; }
    return digits ? Number(digits) : null;
  }
  const out = group();
  if (i < formula.length) throw new Error('unbalanced parenthesis');
  if (Object.keys(out).length === 0) throw new Error('no elements found');
  return out;
}

/** One term of an equation side: `2H2O`, `SO4^2-`, `3 Fe`, `e-` (a bare electron). */
export function parseSpecies(term: string): Species {
  // Strip state symbols — (s), (l), (g), (aq) — which annotate phase and are in essentially every
  // textbook equation, but play no part in balancing (atoms and charge are conserved regardless).
  // Unambiguous vs a multiplier group like Ca(OH)2: those exact letters can't be an element group,
  // and a real multiplier group is never one of them. Done before charge/formula parsing so
  // "Na+(aq)" reads its "+" charge and "H2O(l)" its formula.
  const t = term.trim().replace(/\s+/g, '').replace(/\((?:s|l|g|aq)\)/gi, '');
  const coeffMatch = t.match(/^(\d+)/);
  const coeff = coeffMatch ? Number(coeffMatch[1]) : 1;
  let rest = coeffMatch ? t.slice(coeffMatch[1].length) : t;

  // A free electron carries charge and no atoms — redox half-equations need it.
  if (rest === 'e-' || rest === 'e⁻') return { coeff, counts: {}, charge: -1, formula: 'e-' };

  let charge = 0;
  const chargeMatch = rest.match(/\^(\d*)([+-])$/) ?? rest.match(/(\d*)([+-])$/);
  if (chargeMatch) {
    charge = (Number(chargeMatch[1] || 1)) * (chargeMatch[2] === '+' ? 1 : -1);
    rest = rest.slice(0, rest.length - chargeMatch[0].length);
  }
  return { coeff, counts: parseFormula(rest), charge, formula: rest };
}

export function parseEquation(text: string): { left: Species[]; right: Species[] } {
  // Accept the equilibrium arrow (⇌ and friends) and the common ASCII forms too: balancing an
  // equilibrium is identical to balancing a one-way reaction, so a chemistry learner who writes
  // "N2 + 3H2 ⇌ 2NH3" must not be turned away with "write one arrow". Multi-char ASCII forms come
  // first in the alternation so "<=>" matches whole rather than splitting on its inner "=".
  const arrow = text.split(/<=>|<->|->|→|⟶|⇌|⇋|↔|=/);
  if (arrow.length !== 2) throw new Error('write one arrow (-> , → or ⇌) between reactants and products');
  // A separator plus must have whitespace on BOTH sides. Anything cleverer guesses wrong on
  // charges: "Fe^3+ + e-" has a charge-plus followed by a space, and a one-sided-space rule split
  // the species at the charge. Cramped writing ("CH4+2O2") surfaces as a parse error below whose
  // message says exactly what to do, which beats silently mis-reading an ion.
  const side = (s: string) => s.split(/\s\+\s/).map(parseSpecies);
  const [left, right] = [side(arrow[0].trim()), side(arrow[1].trim())];
  if (left.length === 0 || right.length === 0) throw new Error('both sides need at least one species');
  return { left, right };
}

function totals(side: Species[]): { atoms: Record<string, number>; charge: number } {
  const atoms: Record<string, number> = {};
  let charge = 0;
  for (const sp of side) {
    charge += sp.coeff * sp.charge;
    for (const [el, n] of Object.entries(sp.counts)) atoms[el] = (atoms[el] ?? 0) + sp.coeff * n;
  }
  return { atoms, charge };
}

/** Canonical identity of a species (counts + charge), independent of how it was written —
 *  used to check the learner balanced THIS reaction rather than some other balanced one. */
function speciesKey(sp: Species): string {
  const atoms = Object.entries(sp.counts).sort(([a], [b]) => a.localeCompare(b))
    .map(([el, n]) => `${el}${n}`).join('');
  return `${atoms}${sp.charge ? `^${sp.charge}` : ''}`;
}

export function gradeChemEquation(
  answer: string,
  checker: { reactants?: string[]; products?: string[] },
): CheckerVerdict {
  let eq;
  try {
    eq = parseEquation(answer);
  } catch (e) {
    return { ok: false, detail: `could not read the equation: ${(e as Error).message}` };
  }
  const l = totals(eq.left);
  const r = totals(eq.right);

  const elements = new Set([...Object.keys(l.atoms), ...Object.keys(r.atoms)]);
  const unbalanced = [...elements].filter((el) => (l.atoms[el] ?? 0) !== (r.atoms[el] ?? 0));
  if (unbalanced.length > 0) {
    // Name the element, not the count — the count IS the exercise.
    return { ok: false, detail: `not balanced: ${unbalanced.join(', ')} differ${unbalanced.length === 1 ? 's' : ''} between the sides` };
  }
  if (l.charge !== r.charge) {
    return { ok: false, detail: 'atoms balance but charge does not' };
  }

  // Balanced — but is it the asked-for reaction? Without this, "H2 + H2 -> 2H2" grades as chemistry.
  if (checker.reactants && checker.products) {
    const keysOf = (list: string[]) => list.map((f) => speciesKey(parseSpecies(f))).sort();
    const wantL = keysOf(checker.reactants);
    const wantR = keysOf(checker.products);
    const gotL = eq.left.map(speciesKey).sort();
    const gotR = eq.right.map(speciesKey).sort();
    if (JSON.stringify(wantL) !== JSON.stringify(gotL) || JSON.stringify(wantR) !== JSON.stringify(gotR)) {
      return { ok: false, detail: 'balanced, but not the reaction that was asked' };
    }
  }
  return { ok: true, detail: 'balanced: every element and the charge are conserved' };
}

// ── notes: pitch arithmetic, enharmonic-aware ──────────────────────────────────────────────────

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** `C#4` -> { pc, absolute } — pc is the semitone class (0–11), absolute is MIDI-style when an
 *  octave is given. Accidentals: # ♯ (+1 each), b ♭ (−1 each), x (+2). Throws on non-notes. */
export function parseNote(raw: string): { pc: number; absolute: number | null } {
  const m = raw.trim().match(/^([A-Ga-g])([#♯b♭x♮]*)(-?\d+)?$/);
  if (!m) throw new Error(`“${raw.trim()}” is not a note name`);
  const letter = m[1].toUpperCase();
  let pc = LETTER_PC[letter];
  for (const acc of m[2]) {
    if (acc === '#' || acc === '♯') pc += 1;
    else if (acc === 'b' || acc === '♭') pc -= 1;
    else if (acc === '♮') { /* natural sign — a valid way to write "F♮" for plain F; no change */ }
    else pc += 2; // x, double sharp
  }
  const octave = m[3] !== undefined ? Number(m[3]) : null;
  return {
    pc: ((pc % 12) + 12) % 12,
    absolute: octave !== null ? pc + 12 * (octave + 1) : null,
  };
}

/**
 * Note answers compare by PITCH, not spelling: C# names the same key as Db, and an answer is not
 * wrong for choosing the other name. Octaves are compared only when the EXPECTED note carries one —
 * "a major third above C" wants E in any octave; "a major third above C4" wants E4 specifically.
 */
export function gradeNotes(
  answers: string[],
  checker: { expected: string[]; ordered?: boolean },
): CheckerVerdict {
  let got;
  try {
    got = answers.map(parseNote);
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  const want = checker.expected.map(parseNote);
  const key = (n: { pc: number; absolute: number | null }, wantAbsolute: boolean) =>
    wantAbsolute && n.absolute !== null ? `a${n.absolute}` : `p${n.pc}`;

  if (checker.ordered) {
    const hits = want.filter((w, i) => {
      const g = got[i];
      return g !== undefined && key(g, w.absolute !== null) === key(w, w.absolute !== null);
    }).length;
    return {
      ok: hits === want.length && got.length === want.length,
      detail: `${hits}/${want.length} in the right position`,
    };
  }
  const remaining = want.map((w) => key(w, w.absolute !== null));
  let hits = 0;
  for (const g of got) {
    const i = remaining.findIndex((k) => k === key(g, k.startsWith('a')));
    if (i >= 0) { remaining.splice(i, 1); hits++; }
  }
  const ok = hits === want.length && got.length === want.length;
  return { ok, detail: ok ? `all ${want.length} correct` : `${hits}/${want.length} correct` };
}
