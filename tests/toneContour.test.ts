import { describe, it, expect } from 'vitest';
import {
  gradeTone, normalizeContour, contourSimilarity, TONE_TEMPLATES, TONE_SYSTEMS, CONTOUR_LEN, type Tone,
} from '../src/shared/toneContour.js';

// Synthetic pitch tracks in Hz, shaped like the tone they name. A tone grader that works must
// judge these by SHAPE, independent of the speaker's pitch and their speaking rate — those two
// invariances are the whole reason the contour is median-centered and resampled, so they get their
// own tests rather than being assumed.
const rising = (n = 20) => Array.from({ length: n }, (_, i) => 120 + (60 * i) / (n - 1));   // sắc
const falling = (n = 20) => Array.from({ length: n }, (_, i) => 180 - (60 * i) / (n - 1));  // huyền
const level = (n = 20) => Array.from({ length: n }, () => 150);                             // ngang
const dipping = (n = 20) => Array.from({ length: n }, (_, i) => {                            // hỏi
  const t = i / (n - 1);
  return t < 0.5 ? 160 - 60 * (t / 0.5) : 100 + 50 * ((t - 0.5) / 0.5);
});
// sắc but with a glottal notch two-thirds through — ngã. The notch is what tells them apart.
const brokenRising = (n = 24) => rising(n).map((f, i) =>
  (i === Math.floor(n * 0.5) ? f - 45 : i === Math.floor(n * 0.5) - 1 ? f - 25 : f));

describe('normalizeContour — reduces a pitch track to a comparable shape', () => {
  it('drops unvoiced frames and needs enough voiced signal to judge', () => {
    expect(normalizeContour([0, 0, NaN])).toBeNull();
    expect(normalizeContour([150, 0, 155])).toBeNull(); // only 2 voiced < 4
    expect(normalizeContour(rising())).toHaveLength(CONTOUR_LEN);
  });

  it('is speaker-pitch independent: the same shape an octave up normalizes identically', () => {
    const low = normalizeContour(rising())!;
    const high = normalizeContour(rising().map((f) => f * 2))!; // an octave higher, same contour
    for (let i = 0; i < CONTOUR_LEN; i++) expect(high[i]).toBeCloseTo(low[i], 4);
  });

  it('is speaking-rate independent: 10 frames or 40 frames of a rise normalize alike', () => {
    const slow = normalizeContour(rising(40))!;
    const fast = normalizeContour(rising(10))!;
    expect(contourSimilarity(slow, fast)).toBeGreaterThan(0.99);
  });
});

describe('gradeTone — a rising utterance is sắc, not huyền', () => {
  it('passes the tone it actually matches', () => {
    expect(gradeTone(rising(), 'sac').pass).toBe(true);
    expect(gradeTone(falling(), 'huyen').pass).toBe(true);
    expect(gradeTone(level(), 'ngang').pass).toBe(true);
    expect(gradeTone(dipping(), 'hoi').pass).toBe(true);
  });

  it('fails a tone the contour does not match, and names what it looked like instead', () => {
    const g = gradeTone(rising(), 'huyen'); // rose when huyền should fall
    expect(g.pass).toBe(false);
    expect(g.closest).toBe('sac');
    expect(g.detail).toMatch(/more like sắc .* than huyền/); // named by their display forms
  });

  it('speaker pitch does not change the grade: a high voice saying sắc still passes', () => {
    expect(gradeTone(rising().map((f) => f * 1.6), 'sac').pass).toBe(true);
  });

  it('ngang is judged by flatness, and a moving contour fails it with the range named', () => {
    expect(gradeTone(level(), 'ngang').pass).toBe(true);
    const g = gradeTone(rising(), 'ngang');
    expect(g.pass).toBe(false);
    expect(g.detail).toMatch(/level/);
  });

  it('the hard pair: a smooth rise is sắc and a broken rise is ngã, not each other', () => {
    // Both rise overall; only the mid-contour glottal notch separates them. This is the
    // distinction beginners miss and the one a grader most has to get right.
    expect(gradeTone(rising(), 'sac').pass).toBe(true);
    expect(gradeTone(brokenRising(), 'nga').closest).toBe('nga');
    // A smooth rise must NOT pass as ngã — otherwise the grader rewards the wrong production.
    expect(gradeTone(rising(), 'nga').pass).toBe(false);
  });

  it('too little voiced sound is unscorable — no grade, not a failure', () => {
    const g = gradeTone([0, 0, 150], 'sac');
    expect(g.unscorable).toBe(true);
    expect(g.pass).toBe(false);
    expect(g.detail).toMatch(/record the syllable again/i);
  });
});

describe('TONE_TEMPLATES — each template is most like itself', () => {
  it('every non-level template correlates highest with its own tone', () => {
    const tones = (Object.keys(TONE_TEMPLATES) as Tone[]).filter((t) => t !== 'ngang');
    for (const t of tones) {
      const scores = tones.map((u) => ({ u, s: contourSimilarity(TONE_TEMPLATES[t], TONE_TEMPLATES[u]) }));
      const top = scores.sort((a, b) => b.s - a.s)[0];
      expect(top.u).toBe(t);
    }
  });
});

describe('Mandarin (system "zh") — the four tones grade by the same contour logic', () => {
  it('rising is 2nd tone, falling is 4th, and neither passes as the other', () => {
    expect(gradeTone(rising(), 'tone2', 'zh').pass).toBe(true);
    expect(gradeTone(falling(), 'tone4', 'zh').pass).toBe(true);
    expect(gradeTone(rising(), 'tone4', 'zh').pass).toBe(false);
    expect(gradeTone(falling(), 'tone2', 'zh').pass).toBe(false);
  });

  it('a high-level tone (1st) is judged by flatness, like ngang', () => {
    expect(gradeTone(level(), 'tone1', 'zh').pass).toBe(true);
    expect(gradeTone(rising(), 'tone1', 'zh').pass).toBe(false);
  });

  it('the dipping 3rd tone matches a dip and not a pure rise', () => {
    expect(gradeTone(dipping(), 'tone3', 'zh').pass).toBe(true);
    expect(gradeTone(dipping(), 'tone2', 'zh').pass).toBe(false);
  });

  it('every non-level Mandarin template is most like itself', () => {
    const { templates, levelTones } = TONE_SYSTEMS.zh;
    const tones = Object.keys(templates).filter((t) => !levelTones.includes(t));
    for (const t of tones) {
      const top = tones
        .map((u) => ({ u, s: contourSimilarity(templates[t], templates[u]) }))
        .sort((a, b) => b.s - a.s)[0];
      expect(top.u).toBe(t);
    }
  });
});
