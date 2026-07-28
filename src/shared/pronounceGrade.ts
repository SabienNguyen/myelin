// The one call the Pronounce block makes on each recording: decoded mono audio → the tone grade
// plus the learner's normalized contour (for the overlay). Kept here, pure and shared, so the
// whole audio→grade path is testable with a synthetic waveform and no microphone — the mic
// plumbing (getUserMedia/MediaRecorder/decode) is the only untested seam, and it's the part a
// fake-audio browser run covers.
import { pitchTrack } from './pitchTrack.js';
import { gradeTone, normalizeContour, type ToneGrade, type ToneSystem } from './toneContour.js';

export interface PronounceAttempt {
  grade: ToneGrade;
  /** The learner's contour in the same normalized space as the templates — for the overlay.
   *  null when there wasn't enough voiced sound to draw (grade.unscorable is then true too). */
  contour: number[] | null;
}

export function gradePronunciation(
  samples: Float32Array | number[], sampleRate: number, tone: string, system: ToneSystem = 'vi',
): PronounceAttempt {
  const f0 = pitchTrack(samples, sampleRate);
  return { grade: gradeTone(f0, tone, system), contour: normalizeContour(f0) };
}
