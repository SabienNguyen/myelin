// Telex: the way Vietnamese is typed on an ASCII keyboard — `vieejt` → `việt`, `nhaf` → `nhà`.
// A learner asked for "the correct keyboard for the language"; for Vietnamese that means an input
// method, not an on-screen layout (tapping tone marks is far clumsier than typing them). There is
// no maintained JS library for this — the good implementations are Rust (vi-rs) or browser
// extensions (AVIM) — so this is a compact hand-rolled engine, which the "leverage OSS where it
// exists" rule permits precisely because nothing suitable exists to leverage.
//
// The engine is a STATEFUL replay over the raw keystrokes: a tone key (s f r x j z) is only a tone
// when the current syllable already holds a vowel, otherwise it is the literal consonant it also
// spells (s in "sao", x in "xin", r in "rồi"). Because the transform is a deterministic function
// of the raw keystroke string, `telex(raw)` is pure and testable, and the input component keeps
// the raw buffer and re-derives on every edit (ImeInput.tsx).
//
// Tone PLACEMENT follows the modern ("new") style. It is correct for the vast majority of
// syllables; a few rare vowel clusters are approximate, and the ImeInput toggle always lets the
// learner fall back to a system IME. Documented in tests/telex.test.ts.

const TONE_KEYS: Record<string, number> = { s: 1, f: 2, r: 3, x: 4, j: 5, z: 0 };

// base vowel → its 5 toned forms, indexed by tone (0 = none, 1..5 = sắc huyền hỏi ngã nặng).
const TONE_TABLE: Record<string, string[]> = {
  a: ['a', 'á', 'à', 'ả', 'ã', 'ạ'], ă: ['ă', 'ắ', 'ằ', 'ẳ', 'ẵ', 'ặ'], â: ['â', 'ấ', 'ầ', 'ẩ', 'ẫ', 'ậ'],
  e: ['e', 'é', 'è', 'ẻ', 'ẽ', 'ẹ'], ê: ['ê', 'ế', 'ề', 'ể', 'ễ', 'ệ'],
  i: ['i', 'í', 'ì', 'ỉ', 'ĩ', 'ị'],
  o: ['o', 'ó', 'ò', 'ỏ', 'õ', 'ọ'], ô: ['ô', 'ố', 'ồ', 'ổ', 'ỗ', 'ộ'], ơ: ['ơ', 'ớ', 'ờ', 'ở', 'ỡ', 'ợ'],
  u: ['u', 'ú', 'ù', 'ủ', 'ũ', 'ụ'], ư: ['ư', 'ứ', 'ừ', 'ử', 'ữ', 'ự'],
  y: ['y', 'ý', 'ỳ', 'ỷ', 'ỹ', 'ỵ'],
};
// Reverse: any toned/plain vowel → [base, tone]. Built once.
const VOWEL_INFO = new Map<string, { base: string; tone: number }>();
for (const [base, forms] of Object.entries(TONE_TABLE)) {
  forms.forEach((ch, tone) => VOWEL_INFO.set(ch, { base, tone }));
}
const isVowel = (ch: string) => VOWEL_INFO.has(ch.toLowerCase());

/** Preserve the original letter case when we swap in a diacritic form. */
function matchCase(model: string, ch: string): string {
  return model === model.toUpperCase() && model !== model.toLowerCase() ? ch.toUpperCase() : ch;
}

/** Which vowel of a syllable carries the tone, by index into `letters`. Modern-style placement:
 *  a vowel already bearing a quality mark (â ê ô ă ơ ư) wins; a single vowel takes it; for a plain
 *  cluster it lands on the last vowel when the syllable is closed (ends in a consonant) or is one
 *  of oa/oe/uy, and otherwise on the first vowel of the cluster. */
function toneVowelIndex(letters: string[]): number {
  const vowelIdx = letters.map((c, i) => (isVowel(c) ? i : -1)).filter((i) => i >= 0);
  if (vowelIdx.length === 0) return -1;
  // A quality-marked vowel (â ê ô ă ơ ư) carries the tone. For the ươ cluster BOTH vowels are
  // marked and the tone belongs on the second (được → ợ, người → ờ), so take the LAST marked one.
  const marked = vowelIdx.filter((i) => 'ăâêôơư'.includes(VOWEL_INFO.get(letters[i].toLowerCase())!.base));
  if (marked.length) return marked[marked.length - 1];
  if (vowelIdx.length === 1) return vowelIdx[0];
  const last = vowelIdx[vowelIdx.length - 1];
  const closed = last < letters.length - 1; // a consonant follows the vowel cluster
  const cluster = vowelIdx.map((i) => VOWEL_INFO.get(letters[i].toLowerCase())!.base).join('');
  if (closed || ['oa', 'oe', 'uy'].includes(cluster)) return last;
  return vowelIdx[vowelIdx.length - 2];
}

/** Feed one key into the working syllable (array of already-composed letters), returning the new
 *  syllable. Handles tone keys, the vowel-quality doublings (aa→â, ow→ơ, w→ư), and dd→đ. */
function pushKey(letters: string[], key: string): string[] {
  const lower = key.toLowerCase();

  // Tone key — only if the syllable already has a vowel; else it's the literal consonant.
  if (lower in TONE_KEYS && letters.some(isVowel)) {
    const idx = toneVowelIndex(letters);
    if (idx < 0) return [...letters, key];
    const cur = VOWEL_INFO.get(letters[idx].toLowerCase())!;
    const tone = TONE_KEYS[lower];
    // Re-pressing the same tone key undoes it and emits the literal letter (Telex convention).
    if (cur.tone === tone && tone !== 0) {
      const cleared = matchCase(letters[idx], TONE_TABLE[cur.base][0]);
      return [...letters.slice(0, idx), cleared, ...letters.slice(idx + 1), key];
    }
    const toned = matchCase(letters[idx], TONE_TABLE[cur.base][tone]);
    return [...letters.slice(0, idx), toned, ...letters.slice(idx + 1)];
  }

  const prev = letters[letters.length - 1];
  const prevLower = prev?.toLowerCase();

  // Quality marks by doubling (aa→â, ee→ê, oo→ô) or by w (aw→ă, ow→ơ, uw→ư), and dd→đ.
  if (prev) {
    const dbl: Record<string, string> = { a: 'â', e: 'ê', o: 'ô' };
    if (lower === prevLower && dbl[prevLower]) {
      return [...letters.slice(0, -1), matchCase(prev, dbl[prevLower])];
    }
    if (lower === 'd' && prevLower === 'd') {
      return [...letters.slice(0, -1), matchCase(prev, 'đ')];
    }
    if (lower === 'w') {
      const horn: Record<string, string> = { a: 'ă', o: 'ơ', u: 'ư' };
      // Preserve any tone already on the vowel when adding the horn/breve.
      const info = VOWEL_INFO.get(prevLower);
      if (info && horn[info.base]) {
        return [...letters.slice(0, -1), matchCase(prev, TONE_TABLE[horn[info.base]][info.tone])];
      }
    }
  }
  // Bare w with no vowel to modify is Telex shorthand for ư.
  if (lower === 'w' && !letters.some((c) => 'aou'.includes(VOWEL_INFO.get(c.toLowerCase())?.base ?? '')))
    return [...letters, matchCase(key, 'ư')];

  return [...letters, key];
}

const LETTER = /\p{L}/u;

/** Replay a raw ASCII keystroke string through the Telex engine, syllable by syllable. Pure and
 *  deterministic — the input component holds the raw buffer and calls this on every change. */
export function telex(raw: string): string {
  let out = '';
  let syllable: string[] = [];
  const flush = () => { out += syllable.join(''); syllable = []; };
  for (const ch of raw) {
    if (LETTER.test(ch)) syllable = pushKey(syllable, ch);
    else { flush(); out += ch; }
  }
  flush();
  return out;
}
