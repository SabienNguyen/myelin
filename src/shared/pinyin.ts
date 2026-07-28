// Pinyin tone input — the Mandarin analogue of Telex (telex.ts): type a syllable and a tone
// number, get the toned vowel. `ni3 hao3` → `nǐ hǎo`, `lv4` → `lǜ`, `zhong1` → `zhōng`. Mandarin
// is one of the most-learned languages and, like Vietnamese, can't be typed from a bare ASCII
// keyboard without an input method; this reuses ImeInput's method registry so the second tonal
// language cost almost nothing. Dependency-free — the tone-mark placement rule is well-defined and
// small (tests/pinyin.test.ts).
//
// Unlike Telex, the tone marker is explicit and terminal (the digit ends the syllable), so this is
// a straight syllable-by-syllable pass, not a stateful replay.

const TONES: Record<string, string[]> = {
  // index 0 unused (neutral tone has no mark); 1..4 are the four tones.
  a: ['a', 'ā', 'á', 'ǎ', 'à'], e: ['e', 'ē', 'é', 'ě', 'è'], i: ['i', 'ī', 'í', 'ǐ', 'ì'],
  o: ['o', 'ō', 'ó', 'ǒ', 'ò'], u: ['u', 'ū', 'ú', 'ǔ', 'ù'], 'ü': ['ü', 'ǖ', 'ǘ', 'ǚ', 'ǜ'],
};

function matchCase(model: string, ch: string): string {
  return model === model.toUpperCase() && model !== model.toLowerCase() ? ch.toUpperCase() : ch;
}

/** `v` is the standard ASCII stand-in for ü on a Latin keyboard (lü → "lv"). */
function normalizeV(syllable: string): string {
  return syllable.replace(/v/g, 'ü').replace(/V/g, 'Ü');
}

/** Which vowel of a pinyin syllable carries the tone mark, by the standard rule: an `a` or `e`
 *  always wins; in the `ou` pair the `o` takes it; otherwise it's the last vowel. */
function toneVowelIndex(lower: string): number {
  if (lower.includes('a')) return lower.indexOf('a');
  if (lower.includes('e')) return lower.indexOf('e');
  const ou = lower.indexOf('ou');
  if (ou >= 0) return ou;
  for (let i = lower.length - 1; i >= 0; i--) if ('aeiouü'.includes(lower[i])) return i;
  return -1;
}

function applyTone(syllable: string, tone: number): string {
  if (tone < 1 || tone > 4) return syllable; // neutral (0/5) or none: no mark
  const idx = toneVowelIndex(syllable.toLowerCase());
  if (idx < 0) return syllable;
  const table = TONES[syllable[idx].toLowerCase()];
  if (!table) return syllable;
  return syllable.slice(0, idx) + matchCase(syllable[idx], table[tone]) + syllable.slice(idx + 1);
}

const LETTER = /[a-zA-ZüÜ]/;

/** Convert a raw ASCII+digit buffer into toned pinyin. A digit 1–5 right after a syllable's
 *  letters applies that tone (5 = neutral, no mark) and is consumed; anything else flushes the
 *  pending syllable untoned. Pure and deterministic — ImeInput holds the raw buffer. */
export function pinyin(raw: string): string {
  let out = '';
  let syllable = '';
  const flush = (tone: number) => { out += applyTone(normalizeV(syllable), tone); syllable = ''; };
  for (const ch of raw) {
    if (LETTER.test(ch)) syllable += ch;
    else if (/[0-5]/.test(ch) && syllable) flush(Number(ch));
    else { flush(0); out += ch; }
  }
  flush(0);
  return out;
}
