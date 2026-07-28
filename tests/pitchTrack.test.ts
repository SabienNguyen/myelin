import { describe, it, expect } from 'vitest';
import { detectPitchHz, pitchTrack } from '../src/shared/pitchTrack.js';
import { gradeTone, normalizeContour } from '../src/shared/toneContour.js';

const SR = 16000;

/** A pure sine of `hz` for `seconds`. */
function sine(hz: number, seconds: number, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sr);
  return out;
}

/** A linear pitch glide from `from` to `to` Hz — phase integrated so frequency actually sweeps. */
function glide(from: number, to: number, seconds: number, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = from + (to - from) * (i / (n - 1));
    phase += (2 * Math.PI * f) / sr;
    out[i] = Math.sin(phase);
  }
  return out;
}

describe('detectPitchHz — autocorrelation on a single frame', () => {
  it('recovers the fundamental of a clean sine within a few Hz', () => {
    const frame220 = sine(220, 0.15);
    const frame440 = sine(440, 0.15);
    expect(detectPitchHz(frame220, SR)).toBeCloseTo(220, -0.5); // within ~5 Hz
    expect(detectPitchHz(frame440, SR)).toBeCloseTo(440, -0.5);
  });

  it('does not drop an octave: 100 Hz reads as ~100, not ~50 or ~200', () => {
    const hz = detectPitchHz(sine(100, 0.2), SR);
    expect(hz).toBeGreaterThan(94);
    expect(hz).toBeLessThan(106);
  });

  it('calls silence and white noise unvoiced (0)', () => {
    expect(detectPitchHz(new Float32Array(2048), SR)).toBe(0);
    // Seeded xorshift32 — an aperiodic deterministic generator (a pure function of its seed, not
    // Math.random, which this repo bans). A modulo-of-index "noise" is actually periodic and reads
    // as a real pitch, so it can't stand in for the unvoiced case.
    const noise = new Float32Array(2048);
    let s = 0x9e3779b9 | 0;
    for (let i = 0; i < noise.length; i++) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      noise[i] = ((s >>> 0) / 0xffffffff) * 2 - 1;
    }
    expect(detectPitchHz(noise, SR)).toBe(0);
  });
});

describe('pitchTrack — a waveform becomes an F0 contour', () => {
  it('a steady tone yields a flat, on-pitch track', () => {
    const track = pitchTrack(sine(200, 0.4), SR);
    expect(track.length).toBeGreaterThan(3);
    for (const f of track) expect(f).toBeCloseTo(200, -0.5);
  });

  it('a rising glide yields a monotonic-ish rising track', () => {
    const track = pitchTrack(glide(150, 300, 0.5), SR).filter((f) => f > 0);
    expect(track[track.length - 1]).toBeGreaterThan(track[0] + 50);
  });
});

describe('end to end: waveform → pitchTrack → gradeTone', () => {
  // The two pure modules compose into the whole grading pipeline minus the mic — so this is the
  // closest test to the real feature, and it would fail if either module regressed.
  it('a rising glide grades as sắc and NOT as huyền', () => {
    const f0 = pitchTrack(glide(140, 260, 0.5), SR);
    expect(normalizeContour(f0)).not.toBeNull();
    expect(gradeTone(f0, 'sac').pass).toBe(true);
    expect(gradeTone(f0, 'huyen').pass).toBe(false);
  });

  it('a falling glide grades as huyền, not sắc', () => {
    const f0 = pitchTrack(glide(260, 140, 0.5), SR);
    expect(gradeTone(f0, 'huyen').pass).toBe(true);
    expect(gradeTone(f0, 'sac').pass).toBe(false);
  });

  it('a steady tone grades as ngang (level)', () => {
    const f0 = pitchTrack(sine(180, 0.5), SR);
    expect(gradeTone(f0, 'ngang').pass).toBe(true);
  });
});
