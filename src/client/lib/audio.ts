// Audio for the music-theory checkers: play what the learner TYPED, so notation connects to
// sound. Deliberately never plays the expected answer before grading — hearing the answer would
// leak it; hearing your own attempt is ear training.
//
// WebAudio only — no dependency, no asset. A missing AudioContext (tests, odd builds) makes
// playNotes a silent no-op rather than a crash: sound is an enhancement, never a requirement.

const SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C" | "F#" | "Bb" | "A4" | "C#5" -> frequency in Hz, or null when unparseable.
 *  Default octave 4 (A4 = 440); accidentals # and b, case-insensitive letters. */
export function noteToFreq(raw: string): number | null {
  const m = raw.trim().match(/^([A-Ga-g])([#b♯♭]?)(\d)?$/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  const octave = m[3] ? Number(m[3]) : 4;
  const midi = 12 * (octave + 1) + SEMITONE[letter] + acc;
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Parse a free-text notes answer ("C E G", "c, e, g") into playable frequencies. Unparseable
 *  tokens are skipped — the play button reflects what CAN sound, grading stays the authority. */
export function parseNotes(answer: string): number[] {
  return answer.split(/[\s,]+/).map(noteToFreq).filter((f): f is number => f !== null);
}

/** Arpeggiate then sound together — the two ways a musician checks a chord by ear. */
export function playNotes(answer: string): boolean {
  const freqs = parseNotes(answer);
  const Ctor: typeof AudioContext | undefined = (globalThis as any).AudioContext
    ?? (globalThis as any).webkitAudioContext;
  if (!freqs.length || !Ctor) return false;
  const ctx = new Ctor();
  const t0 = ctx.currentTime;
  const note = (freq: number, at: number, dur: number, gainPeak = 0.18) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0 + at);
    gain.gain.linearRampToValueAtTime(gainPeak, t0 + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + at + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + dur);
  };
  freqs.forEach((f, i) => note(f, i * 0.35, 0.4));            // arpeggio
  const together = freqs.length * 0.35 + 0.15;
  freqs.forEach((f) => note(f, together, 0.9, 0.12));          // the chord
  const total = together + 1.0;
  setTimeout(() => { void ctx.close(); }, total * 1000 + 200);
  return true;
}
