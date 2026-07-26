// Display form of a structured_check answer, shown beside the input as the learner types.
//
// The block prompts learned to render notation (BlockProse), which exposed the other half of the
// asymmetry: a chemistry question could ASK about H₂O in real subscripts while the learner's own
// answer sat beside it as the raw characters `H2O`. The grader normalises case and spacing, so the
// raw form is what must be typed — this makes what they typed READ as what they meant.
//
// Display only, and that is a hard rule: grading always sees the raw string. A transform that fed
// grading would turn a rendering nicety into a silent change of what counts as correct.

const SUB: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
};
const SUP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻',
};

/**
 * The prettified form of one answer, or null when it would be identical — null is the signal to
 * render no preview at all, so plain answers ("42", "mitochondria") get no redundant echo.
 *
 * Two mechanical rules, chosen because they are how people actually type these answers:
 *   * digits directly after a letter or a closing paren subscript — `H2O` → H₂O, `Ca(OH)2` → Ca(OH)₂.
 *     A digit after a space or at the start stays full size, which is also chemically right:
 *     the coefficient in `2H2O` is not a subscript.
 *   * `^` followed by digits/signs superscripts — `SO4^2-` → SO₄²⁻, `x^2` → x².
 *
 * Strings containing `$` are LaTeX territory and are left to BlockProse (the caller checks);
 * mixing the two transforms would mangle real TeX like `x_1`.
 */
export function prettyAnswer(raw: string): string | null {
  if (raw.includes('$')) return null;
  const out = raw
    .replace(/\^([0-9+-]+)/g, (_, sup: string) => [...sup].map((c) => SUP[c] ?? c).join(''))
    .replace(/([A-Za-z)])(\d+)/g, (_, head: string, digits: string) =>
      head + [...digits].map((c) => SUB[c] ?? c).join(''));
  return out === raw ? null : out;
}
