// Turns a mono audio waveform into the frame-by-frame F0 (Hz) array that toneContour.gradeTone
// consumes — the missing middle of the pronunciation pipeline (capture → THIS → grade). Pure DSP,
// no dependency: autocorrelation pitch detection via McLeod's Normalized Square Difference
// Function (NSDF), which is octave-error-resistant where a plain ACF is not. A browser mic feeds
// getFloatTimeDomainData into these functions; nothing here touches an audio device, so it is
// tested with synthetic tones instead. Consumed today by tests/pitchTrack.test.ts.
//
// Voiced speech F0 sits roughly 70–500 Hz; frames without strong periodicity (silence, noise,
// consonants) return 0 so normalizeContour drops them as unvoiced.

export interface PitchOpts {
  minF0?: number;
  maxF0?: number;
  /** Fraction of the strongest NSDF peak a candidate peak must reach — and the floor below which a
   *  frame is called unvoiced. Higher = stricter (fewer false pitches, more dropped frames). */
  clarity?: number;
}

/** Estimate the fundamental of one frame, in Hz. Returns 0 when the frame has no strong periodicity
 *  (unvoiced). NSDF ranges [-1, 1]; a clean periodic frame peaks near 1 at the period's lag. */
export function detectPitchHz(
  frame: Float32Array | number[], sampleRate: number, opts: PitchOpts = {},
): number {
  const { minF0 = 70, maxF0 = 500, clarity = 0.6 } = opts;
  const n = frame.length;
  const minLag = Math.max(2, Math.floor(sampleRate / maxF0));
  const maxLag = Math.min(n - 1, Math.floor(sampleRate / minF0));
  if (maxLag <= minLag) return 0;

  // DC removal — a nonzero mean biases the autocorrelation toward lag 0.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += frame[i];
  mean /= n;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = frame[i] - mean;

  // NSDF: 2·Σ x[i]x[i+τ] / Σ (x[i]² + x[i+τ]²), which normalizes each lag by its own windows'
  // energy so a decaying signal doesn't bias short lags upward the way a raw ACF does.
  const nsdf = new Float64Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    let ac = 0; let m = 0;
    for (let i = 0; i + tau < n; i++) {
      ac += x[i] * x[i + tau];
      m += x[i] * x[i] + x[i + tau] * x[i + tau];
    }
    nsdf[tau] = m > 0 ? (2 * ac) / m : 0;
  }

  // First NSDF peak reaching `clarity`·(global max): the first peak is the true period, later peaks
  // are its multiples — picking the tallest instead would drop an octave on some voices.
  let globalMax = 0;
  for (let tau = minLag + 1; tau < maxLag; tau++) {
    if (nsdf[tau] > nsdf[tau - 1] && nsdf[tau] >= nsdf[tau + 1] && nsdf[tau] > globalMax) {
      globalMax = nsdf[tau];
    }
  }
  if (globalMax < clarity) return 0; // no strong periodicity → unvoiced

  const cut = clarity * globalMax;
  let chosen = -1;
  for (let tau = minLag + 1; tau < maxLag; tau++) {
    if (nsdf[tau] > nsdf[tau - 1] && nsdf[tau] >= nsdf[tau + 1] && nsdf[tau] >= cut) {
      chosen = tau; break;
    }
  }
  if (chosen < 0) return 0;

  // Parabolic interpolation around the chosen lag for sub-sample accuracy — without it, F0
  // resolution is quantized to integer lags and a steady tone reads as a tiny staircase.
  const y0 = nsdf[chosen - 1]; const y1 = nsdf[chosen]; const y2 = nsdf[chosen + 1];
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  return sampleRate / (chosen + shift);
}

/** Slide a window across the waveform and emit one F0 per hop — the contour array gradeTone wants.
 *  Window defaults to ~4 periods of the lowest detectable F0 so even a low voice has enough signal
 *  per frame; unvoiced frames come back as 0 and are dropped downstream. */
export function pitchTrack(
  samples: Float32Array | number[], sampleRate: number, opts: PitchOpts = {},
): number[] {
  const minF0 = opts.minF0 ?? 70;
  const win = Math.min(samples.length, Math.ceil((sampleRate / minF0) * 4));
  const hop = Math.max(1, Math.floor(win / 4));
  const out: number[] = [];
  for (let start = 0; start + win <= samples.length; start += hop) {
    const frame = Array.prototype.slice.call(samples, start, start + win) as number[];
    out.push(detectPitchHz(frame, sampleRate, opts));
  }
  // A signal shorter than one window still deserves a single estimate rather than an empty track.
  if (out.length === 0 && samples.length > 0) {
    out.push(detectPitchHz(Array.prototype.slice.call(samples), sampleRate, opts));
  }
  return out;
}
