// Turns a mono audio waveform into the frame-by-frame F0 (Hz) array that toneContour.gradeTone
// consumes — the missing middle of the pronunciation pipeline (capture → THIS → grade).
//
// Per-frame pitch detection is delegated to `pitchy` (MIT), the maintained implementation of
// McLeod's Normalized Square Difference Function — the exact octave-error-resistant algorithm this
// module used to hand-roll. Leveraging the library rather than our own NSDF was a deliberate call
// (the "use OSS where it exists" rule): pitchy is single-purpose, TypeScript, and battle-tested as
// a real-time tuner. What stays ours is the part no library covers: the window/hop sweep that
// turns a whole utterance into a contour, and the voiced-frame gating tuned for speech F0.
//
// Voiced speech F0 sits roughly 70–500 Hz; frames without strong periodicity (silence, noise,
// consonants) or out of that band return 0 so normalizeContour drops them as unvoiced.
import { PitchDetector } from 'pitchy';

export interface PitchOpts {
  minF0?: number;
  maxF0?: number;
  /** Minimum NSDF clarity [0,1] for a frame to count as voiced — pitchy's clarityThreshold.
   *  Higher = stricter (fewer false pitches, more dropped frames). */
  clarity?: number;
}

// One detector per frame length; making one allocates FFT scratch, so reuse across frames.
const detectors = new Map<number, PitchDetector<Float32Array>>();
function detectorFor(n: number): PitchDetector<Float32Array> {
  let d = detectors.get(n);
  if (!d) { d = PitchDetector.forFloat32Array(n); detectors.set(n, d); }
  return d;
}

function toFloat32(frame: Float32Array | number[]): Float32Array {
  return frame instanceof Float32Array ? frame : Float32Array.from(frame);
}

/** Estimate the fundamental of one frame, in Hz. Returns 0 when the frame is unvoiced (clarity
 *  below threshold) or the pitch falls outside the speech band. */
export function detectPitchHz(
  frame: Float32Array | number[], sampleRate: number, opts: PitchOpts = {},
): number {
  const { minF0 = 70, maxF0 = 500, clarity = 0.6 } = opts;
  const buf = toFloat32(frame);
  const detector = detectorFor(buf.length);
  detector.clarityThreshold = clarity;
  const [hz, clar] = detector.findPitch(buf, sampleRate);
  if (!hz || clar < clarity || hz < minF0 || hz > maxF0) return 0;
  return hz;
}

/** Slide a window across the waveform and emit one F0 per hop — the contour array gradeTone wants.
 *  Window defaults to ~4 periods of the lowest detectable F0 so even a low voice has enough signal
 *  per frame; unvoiced frames come back as 0 and are dropped downstream. */
export function pitchTrack(
  samples: Float32Array | number[], sampleRate: number, opts: PitchOpts = {},
): number[] {
  const minF0 = opts.minF0 ?? 70;
  const all = toFloat32(samples);
  const win = Math.min(all.length, Math.ceil((sampleRate / minF0) * 4));
  const hop = Math.max(1, Math.floor(win / 4));
  const out: number[] = [];
  for (let start = 0; start + win <= all.length; start += hop) {
    out.push(detectPitchHz(all.subarray(start, start + win), sampleRate, opts));
  }
  // A signal shorter than one window still deserves a single estimate rather than an empty track.
  if (out.length === 0 && all.length > 0) out.push(detectPitchHz(all, sampleRate, opts));
  return out;
}
