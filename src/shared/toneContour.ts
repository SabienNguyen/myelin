// The mechanical core of tone-language pronunciation grading (docs/pronunciation-roadmap.md).
// Vietnamese tones ARE pitch (F0) contours — sắc rises, huyền falls, hỏi dips then curls up — so a
// learner's tone can be graded the same honest way a numeric answer is: compare the SHAPE of their
// pitch track against a reference template, no model opinion. These are the pure functions that do
// that comparison; the mic capture and the structured_check checker-kind that will call them are
// the remaining wiring, kept out of here so the grading math is testable without an audio device.
//
// Consumed today by tests/toneContour.test.ts. Not yet wired into a block — deliberately, until the
// mic-capture UX is designed.

/** The six Vietnamese tones, keyed by their diacritic name. Kept as the default tone type. */
export type Tone = 'ngang' | 'huyen' | 'sac' | 'hoi' | 'nga' | 'nang';

/** A tone LANGUAGE. Vietnamese and Mandarin both make tone-from-pitch-contour, so the same grader
 *  serves both — only the template set and which tone is "level" differ. */
export type ToneSystem = 'vi' | 'zh';

/** Number of samples every contour is resampled to. Coarse on purpose: tone identity lives in the
 *  gross shape (rise / fall / dip), not fine detail, and a learner's mic is noisy. */
export const CONTOUR_LEN = 16;

interface ToneSystemDef {
  /** Reference SHAPES in normalizeContour's space (median-centered semitones, CONTOUR_LEN). */
  templates: Record<string, number[]>;
  /** Tones defined by the ABSENCE of movement — judged by flatness, not correlation. */
  levelTones: string[];
  /** Display names for the UI. */
  names: Record<string, string>;
}

/** Per-language reference templates, hand-drawn from the standard descriptions (a v1 good enough to
 *  tell the tones apart; corpus-fit templates are a later upgrade). Values are relative — only the
 *  shape matters. Vietnamese: the six diacritic tones. Mandarin: the four tones, T1 high-level (so
 *  judged by flatness like ngang), T2 rising, T3 low-dipping, T4 sharp falling. */
export const TONE_SYSTEMS: Record<ToneSystem, ToneSystemDef> = {
  vi: {
    templates: {
      ngang: ramp(0, 0),               // level, held flat
      huyen: ramp(2, -3),              // starts mid, drifts steadily down
      sac: ramp(-2, 4),                // rises sharply
      hoi: dip(-1, -4, 1),             // dips low, then curls back up
      nga: brokenRise(),               // rises, but with a glottal catch (a notch) partway
      nang: ramp(-1, -4).map((v, i) => (i > CONTOUR_LEN * 0.6 ? -8 : v)), // low, cut off abruptly
    },
    levelTones: ['ngang'],
    names: {
      ngang: 'ngang (level)', huyen: 'huyền (falling)', sac: 'sắc (rising)',
      hoi: 'hỏi (dip-rise)', nga: 'ngã (broken rise)', nang: 'nặng (heavy)',
    },
  },
  zh: {
    templates: {
      tone1: ramp(0, 0),               // first tone: high and level
      tone2: ramp(-2, 4),              // second tone: rising
      tone3: dip(-1, -5, 0),           // third tone: dips low, small recovery
      tone4: ramp(4, -5),              // fourth tone: sharp fall from high
    },
    levelTones: ['tone1'],
    names: {
      tone1: '1st — high level (mā)', tone2: '2nd — rising (má)',
      tone3: '3rd — dipping (mǎ)', tone4: '4th — falling (mà)',
    },
  },
};

/** Vietnamese templates, kept as a named export for callers that predate tone systems. */
export const TONE_TEMPLATES = TONE_SYSTEMS.vi.templates as Record<Tone, number[]>;

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
  closest: string;
  /** Correlation with the target template, [-1, 1] (or the flatness verdict for a level tone). */
  similarity: number;
  /** Human-readable result, naming the miss the way the pattern checker names its expected value. */
  detail: string;
  /** null-returning normalize means we couldn't hear enough — no grade, not a fail. */
  unscorable: boolean;
}

/** Flatness threshold (semitones) below which a contour reads as a level tone. */
const FLAT_RANGE = 2.5;
/** Minimum correlation with the target template to count as that tone. */
const MATCH_THRESHOLD = 0.6;

/** Grade a learner's pitch track against the intended tone of a tone system (Vietnamese by
 *  default). A pass requires that the intended tone is BOTH the best-matching template AND clears
 *  the threshold — matching the equation grader's spirit that being close to the right shape isn't
 *  enough if you're closer to a wrong one. A level tone (ngang, Mandarin T1) is judged by flatness
 *  instead of correlation, since a flat line has no shape to correlate. */
export function gradeTone(f0Hz: number[], target: string, system: ToneSystem = 'vi'): ToneGrade {
  const def = TONE_SYSTEMS[system];
  const name = (t: string) => def.names[t] ?? t;
  const c = normalizeContour(f0Hz);
  if (!c) {
    return { pass: false, closest: target, similarity: 0, unscorable: true,
      detail: 'Not enough voiced sound to grade — record the syllable again, a little longer.' };
  }
  const range = contourRange(c);

  if (def.levelTones.includes(target)) {
    const pass = range < FLAT_RANGE;
    return { pass, closest: pass ? target : bestMatch(c, def).tone, similarity: -range, unscorable: false,
      detail: pass ? `Level and steady — that's ${name(target)}.`
        : `That contour moved ${range.toFixed(1)} semitones; ${name(target)} should stay level.` };
  }

  const { tone: closest } = bestMatch(c, def);
  const targetScore = contourSimilarity(c, def.templates[target]);
  const pass = closest === target && targetScore >= MATCH_THRESHOLD && range >= FLAT_RANGE;
  // On a miss, append the fix — how the target tone should MOVE — not just the diagnosis. The cue is
  // read off the target's own template so it always matches what's being graded.
  const cue = ` To get ${name(target)}, ${shapeCue(def.templates[target])}.`;
  const detail = pass
    ? `Correct — your pitch traced the ${name(target)} contour.`
    : range < FLAT_RANGE
      ? `That came out nearly level; ${name(target)} needs a clear pitch movement.${cue}`
      : `That contour looks more like ${name(closest)} than ${name(target)}.${cue}`;
  return { pass, closest, similarity: targetScore, unscorable: false, detail };
}

/** A one-phrase corrective for a tone, READ OFF ITS OWN reference template rather than hand-written
 *  per tone — so the coaching can never drift from what the grader actually checks against. Compares
 *  the head and tail of the template and looks for a mid-contour trough, then names the movement to
 *  aim for: the difference between "you produced the wrong tone" (a diagnosis) and "sắc rises, so
 *  start low and finish higher" (a fix). Semitone gaps are small on purpose — these curves are
 *  median-centered, so ~1.5 is already an audible move. */
export function shapeCue(template: number[]): string {
  const head = template.slice(0, 3).reduce((s, x) => s + x, 0) / 3;
  const tail = template.slice(-3).reduce((s, x) => s + x, 0) / 3;
  const low = Math.min(...template);
  const lowIdx = template.indexOf(low);
  const dips = lowIdx > CONTOUR_LEN * 0.2 && lowIdx < CONTOUR_LEN * 0.8
    && low < head - 1 && low < tail - 1;
  if (dips) return 'dip low through the middle, then lift the end back up';
  if (tail - head > 1.5) return 'start low and finish clearly higher';
  if (head - tail > 1.5) return 'start high and let the pitch fall away';
  return 'keep a clear, steady pitch movement';
}

/** The template most correlated with `c`, among the system's non-level tones. */
function bestMatch(c: number[], def: ToneSystemDef): { tone: string; score: number } {
  let best = { tone: '', score: -Infinity };
  for (const tone of Object.keys(def.templates)) {
    if (def.levelTones.includes(tone)) continue;
    const score = contourSimilarity(c, def.templates[tone]);
    if (score > best.score) best = { tone, score };
  }
  return best;
}
