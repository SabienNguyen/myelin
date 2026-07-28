// The mechanical core of tone-language pronunciation grading (docs/pronunciation-roadmap.md).
// Vietnamese tones ARE pitch (F0) contours — sắc rises, huyền falls, hỏi dips then curls up — so a
// learner's tone can be graded the same honest way a numeric answer is: compare the SHAPE of their
// pitch track against a reference template, no model opinion. These are the pure functions that do
// that comparison; the mic capture and the structured_check checker-kind that will call them are
// the remaining wiring, kept out of here so the grading math is testable without an audio device.
//
// Consumed today by tests/toneContour.test.ts. Not yet wired into a block — deliberately, until the
// mic-capture UX is designed.

/** The six Vietnamese tones, keyed by their diacritic name. */
export type Tone = 'ngang' | 'huyen' | 'sac' | 'hoi' | 'nga' | 'nang';

/** Number of samples every contour is resampled to. Coarse on purpose: tone identity lives in the
 *  gross shape (rise / fall / dip), not fine detail, and a learner's mic is noisy. */
export const CONTOUR_LEN = 16;

/** Reference SHAPES, already in the normalized space normalizeContour produces (median-centered
 *  semitones, CONTOUR_LEN samples). Hand-drawn from the standard descriptions rather than measured
 *  — a v1 template good enough to tell the tones apart; a corpus-fit template is a later upgrade.
 *  Values are relative, so only their shape matters, not their magnitude. */
export const TONE_TEMPLATES: Record<Tone, number[]> = {
  ngang: ramp(0, 0),               // level, held flat
  huyen: ramp(2, -3),              // starts mid, drifts steadily down
  sac: ramp(-2, 4),                // rises sharply
  hoi: dip(-1, -4, 1),             // dips low, then curls back up
  nga: brokenRise(),               // rises, but with a glottal catch (a notch) partway
  nang: ramp(-1, -4).map((v, i) => (i > CONTOUR_LEN * 0.6 ? -8 : v)), // low, then cut off abruptly
};

/** A straight line from `start` to `end` over CONTOUR_LEN samples. */
function ramp(start: number, end: number): number[] {
  return Array.from({ length: CONTOUR_LEN }, (_, i) =>
    start + (end - start) * (i / (CONTOUR_LEN - 1)));
}

/** A V-shape: from `start` down to `low` at the trough, back up to `end`. */
function dip(start: number, low: number, end: number): number[] {
  const mid = Math.floor(CONTOUR_LEN / 2);
  return Array.from({ length: CONTOUR_LEN }, (_, i) => (i <= mid
    ? start + (low - start) * (i / mid)
    : low + (end - low) * ((i - mid) / (CONTOUR_LEN - 1 - mid))));
}

/** ngã: an overall rise with a downward notch in the middle — the audible glottal break that
 *  distinguishes it from sắc's smooth rise, which is the pair beginners confuse most. */
function brokenRise(): number[] {
  const base = ramp(-2, 4);
  const notch = Math.floor(CONTOUR_LEN / 2);
  base[notch] -= 5; base[notch - 1] -= 3;
  return base;
}

/** A pitch track (Hz per frame, 0/NaN for unvoiced frames) reduced to a comparable shape:
 *  unvoiced frames dropped, converted to semitones around the track's OWN median so a bass and a
 *  soprano saying the same tone land on the same curve, then resampled to CONTOUR_LEN so speaking
 *  rate drops out. Returns null when there is too little voiced signal to judge — the honest
 *  "couldn't hear enough to grade" case, which the caller must treat as no-evidence, not a fail. */
export function normalizeContour(f0Hz: number[]): number[] | null {
  const voiced = f0Hz.filter((f) => Number.isFinite(f) && f > 0);
  if (voiced.length < 4) return null;
  const median = [...voiced].sort((a, b) => a - b)[Math.floor(voiced.length / 2)];
  if (median <= 0) return null;
  const semis = voiced.map((f) => 12 * Math.log2(f / median));
  return resample(semis, CONTOUR_LEN);
}

/** Linear resample of `xs` to exactly `n` points. */
function resample(xs: number[], n: number): number[] {
  if (xs.length === n) return [...xs];
  if (xs.length === 1) return Array(n).fill(xs[0]);
  return Array.from({ length: n }, (_, i) => {
    const pos = (i / (n - 1)) * (xs.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, xs.length - 1);
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
  });
}

/** Pearson correlation of two equal-length contours — measures shared SHAPE independent of scale
 *  and offset, which is exactly the tone-identity signal (a bigger or higher rise is still a rise).
 *  A flat contour has zero variance and no shape to correlate; ngang is handled by the grader
 *  separately rather than pretended to correlate here. Range [-1, 1]; returns 0 for a flat input. */
export function contourSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const mean = (xs: number[]) => xs.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const ma = mean(a); const mb = mean(b);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma; const xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/** How flat a normalized contour is: the peak-to-trough range in semitones. ngang (level tone) is
 *  the one tone defined by the ABSENCE of movement, so it can't be told apart by correlation —
 *  it's identified by a small range instead. */
function contourRange(c: number[]): number {
  return Math.max(...c) - Math.min(...c);
}

export interface ToneGrade {
  /** True when the learner's contour matches the intended tone well enough to count. */
  pass: boolean;
  /** The tone their contour actually looks most like — equals `target` on a pass. */
  closest: Tone;
  /** Correlation with the target template, [-1, 1] (or the flatness verdict for ngang). */
  similarity: number;
  /** Human-readable result, naming the miss the way the pattern checker names its expected value. */
  detail: string;
  /** null-returning normalize means we couldn't hear enough — no grade, not a fail. */
  unscorable: boolean;
}

/** Flatness threshold (semitones) below which a contour reads as level (ngang). */
const FLAT_RANGE = 2.5;
/** Minimum correlation with the target template to count as that tone. */
const MATCH_THRESHOLD = 0.6;

/** Grade a learner's pitch track against the intended tone. A pass requires that the intended tone
 *  is BOTH the best-matching template AND clears the threshold — matching the equation grader's
 *  spirit that being close to the right shape isn't enough if you're closer to a wrong one. */
export function gradeTone(f0Hz: number[], target: Tone): ToneGrade {
  const c = normalizeContour(f0Hz);
  if (!c) {
    return { pass: false, closest: target, similarity: 0, unscorable: true,
      detail: 'Not enough voiced sound to grade — record the syllable again, a little longer.' };
  }
  const range = contourRange(c);

  // ngang is the flat tone: judged by absence of movement, not by correlating a flat line.
  if (target === 'ngang') {
    const pass = range < FLAT_RANGE;
    return { pass, closest: pass ? 'ngang' : bestMatch(c).tone, similarity: -range, unscorable: false,
      detail: pass ? 'Level and steady — that\'s ngang.'
        : `That contour moved ${range.toFixed(1)} semitones; ngang should stay level.` };
  }

  const { tone: closest, score } = bestMatch(c);
  const targetScore = contourSimilarity(c, TONE_TEMPLATES[target]);
  const pass = closest === target && targetScore >= MATCH_THRESHOLD && range >= FLAT_RANGE;
  const detail = pass
    ? `Correct — your pitch traced the ${target} contour.`
    : range < FLAT_RANGE
      ? `That came out nearly level (like ngang); ${target} needs a clear pitch movement.`
      : `That contour looks more like ${closest} than ${target}.`;
  return { pass, closest, similarity: targetScore, unscorable: false, detail };
}

/** The template most correlated with `c`, among the non-level tones. */
function bestMatch(c: number[]): { tone: Tone; score: number } {
  let best: { tone: Tone; score: number } = { tone: 'sac', score: -Infinity };
  for (const tone of Object.keys(TONE_TEMPLATES) as Tone[]) {
    if (tone === 'ngang') continue;
    const score = contourSimilarity(c, TONE_TEMPLATES[tone]);
    if (score > best.score) best = { tone, score };
  }
  return best;
}
