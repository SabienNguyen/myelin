import { describe, it, expect } from 'vitest';
import { gradePronunciation } from '../src/shared/pronounceGrade.js';

const SR = 16000;

/** A linear pitch glide, phase-integrated so the frequency actually sweeps — a stand-in for a
 *  learner's spoken syllable rising or falling in pitch. */
function glide(from: number, to: number, seconds = 0.5, sr = SR): Float32Array {
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

function steady(hz: number, seconds = 0.5, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sr);
  return out;
}

// gradePronunciation is the one call the mic block makes per recording — decoded audio to a tone
// grade plus the overlay contour. It composes pitchTrack (pitchy) and gradeTone, both already
// tested; this pins that the composition grades a real waveform the way the tone demands, and
// returns a drawable contour on a scorable attempt.
describe('gradePronunciation — a spoken waveform graded on its tone', () => {
  it('a rising glide passes sắc and fails huyền, and yields a contour to overlay', () => {
    const rising = glide(140, 260);
    const asSac = gradePronunciation(rising, SR, 'sac');
    expect(asSac.grade.pass).toBe(true);
    expect(asSac.contour).not.toBeNull();
    expect(gradePronunciation(rising, SR, 'huyen').grade.pass).toBe(false);
  });

  it('a falling glide passes huyền', () => {
    expect(gradePronunciation(glide(260, 140), SR, 'huyen').grade.pass).toBe(true);
  });

  it('a steady tone passes ngang (level)', () => {
    expect(gradePronunciation(steady(180), SR, 'ngang').grade.pass).toBe(true);
  });

  it('silence is unscorable — no grade, not a fail', () => {
    const out = gradePronunciation(new Float32Array(SR / 2), SR, 'sac');
    expect(out.grade.unscorable).toBe(true);
    expect(out.grade.pass).toBe(false);
    expect(out.contour).toBeNull();
  });
});
