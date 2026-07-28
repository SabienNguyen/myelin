// pronounce — say a word and be graded on the TONE, the first block that grades doing-not-knowing
// for sound. Flow (the one the learner chose): hear the reference, record yourself, see your pitch
// contour drawn over the target's so you can SEE where you fell. The audio never leaves the
// browser — capture, pitch tracking, grading (gradePronunciation) are all local, and the overlay
// makes the machine verdict transparent. A single lucky attempt isn't mastery, so the block
// withholds its `applied` result until the learner hits the tone cleanly `required` times.
import { useRef, useState } from 'react';
import { MicrophoneIcon as Microphone } from '@phosphor-icons/react/dist/csr/Microphone';
import { SpeakerHighIcon as SpeakerHigh } from '@phosphor-icons/react/dist/csr/SpeakerHigh';
import { CheckIcon as Check } from '@phosphor-icons/react';
import { StagePortal } from '../StagePortal.js';
import { panelBus } from '../../lib/panelBus.js';
import { pickVoice } from './Speak.js';
import { gradePronunciation } from '../../../shared/pronounceGrade.js';
import { TONE_SYSTEMS, CONTOUR_LEN, type ToneSystem, type ToneGrade } from '../../../shared/toneContour.js';

/** Decode a recorded blob to mono PCM at the AudioContext's rate — the array pitchTrack wants. */
async function decodeMono(blob: Blob): Promise<{ samples: Float32Array; sampleRate: number }> {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    return { samples: buf.getChannelData(0), sampleRate: buf.sampleRate };
  } finally { void ctx.close(); }
}

/** The two contours drawn in one box, learner over template, so a miss is visible as a shape that
 *  doesn't trace the reference. Both are already in the normalized semitone space. */
function Overlay({ template, learner }: { template: number[]; learner: number[] | null }) {
  const W = 260; const H = 90; const pad = 8;
  const all = [...template, ...(learner ?? [])];
  const lo = Math.min(...all) - 1; const hi = Math.max(...all) + 1;
  const x = (i: number) => pad + (i / (CONTOUR_LEN - 1)) * (W - 2 * pad);
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const path = (c: number[]) => c.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg className="pronounce-overlay" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="your pitch over the target">
      <path d={path(template)} className="pronounce-target" fill="none" />
      {learner && <path d={path(learner)} className="pronounce-learner" fill="none" />}
    </svg>
  );
}

export function Pronounce({ args, result, addResult }: {
  args: { word: string; lang: string; tone: string; toneSystem?: ToneSystem; gloss?: string; requiredPasses?: number; pageSlug: string };
  result: any; addResult: (r: any) => void;
}) {
  const system: ToneSystem = args.toneSystem ?? 'vi';
  const def = TONE_SYSTEMS[system];
  const toneName = def.names[args.tone] ?? args.tone;
  const template = def.templates[args.tone];
  const required = Math.min(5, Math.max(1, args.requiredPasses ?? 3));
  const [passes, setPasses] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [best, setBest] = useState(0);
  const [recording, setRecording] = useState(false);
  const [last, setLast] = useState<{ grade: ToneGrade; contour: number[] | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);

  if (result) {
    return (
      <div className="block pronounce done">
        <span className="graded-tag"><Check size={12} weight="bold" aria-hidden /> graded</span>
        <p>{args.word} — {result.applied
          ? `${result.passes}/${result.required} clean ✓`
          : `${result.passes}/${result.required} clean`}</p>
      </div>
    );
  }

  const hear = () => {
    const synth = window.speechSynthesis;
    const voice = synth && pickVoice(synth.getVoices(), args.lang);
    if (!synth || !voice) { setError(`No ${args.lang} voice on this device — use a native recording.`); return; }
    const u = new SpeechSynthesisUtterance(args.word);
    u.voice = voice; u.lang = voice.lang; u.rate = 0.8;
    synth.cancel(); synth.speak(u);
  };

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        try {
          const { samples, sampleRate } = await decodeMono(new Blob(chunks));
          const { grade, contour } = gradePronunciation(samples, sampleRate, args.tone, system);
          setLast({ grade, contour });
          setAttempts((a) => a + 1);
          if (grade.unscorable) return;
          setBest((b) => Math.max(b, grade.similarity));
          if (grade.pass) {
            setPasses((p) => {
              const next = p + 1;
              if (next >= required) {
                addResult({ passes: next, required, applied: true, attempts: attempts + 1, bestSimilarity: Math.max(best, grade.similarity) });
              }
              return next;
            });
          }
        } catch { setError('Could not read that recording — try again.'); }
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch { setError('Microphone unavailable — check the browser\'s mic permission.'); }
  };

  const stop = () => { recorder.current?.stop(); setRecording(false); };

  const inner = (
    <div className="block pronounce">
      <h2><Microphone size={16} weight="duotone" /> Say it</h2>
      <p className="pronounce-word">{args.word}{args.gloss && <span className="pronounce-gloss"> — {args.gloss}</span>}</p>
      <p className="pronounce-tone">target tone: <strong>{toneName}</strong></p>

      <div className="pronounce-controls">
        <button type="button" onClick={hear} className="pronounce-hear">
          <SpeakerHigh size={15} weight="duotone" aria-hidden /> Hear it
        </button>
        {recording
          ? <button type="button" onClick={stop} className="pronounce-rec is-recording">Stop</button>
          : <button type="button" onClick={start} className="pronounce-rec"><Microphone size={15} weight="duotone" aria-hidden /> Record</button>}
      </div>

      {last && (
        <div className="pronounce-feedback">
          <Overlay template={template} learner={last.contour} />
          <p className={last.grade.pass ? 'pronounce-ok' : 'pronounce-miss'}>{last.grade.detail}</p>
        </div>
      )}
      {error && <p className="pronounce-error" role="status">{error}</p>}

      <p className="pronounce-progress" role="status">
        {passes}/{required} clean {passes >= required ? '— done ✓' : `— say it ${toneName} cleanly ${required - passes} more time${required - passes === 1 ? '' : 's'}`}
      </p>
      {/* Stop early with an honest partial — passes < required means it won't mint mastery. */}
      {passes < required && attempts > 0 && (
        <button type="button" className="pronounce-give-up"
          onClick={() => addResult({ passes, required, applied: false, attempts, bestSimilarity: best })}>
          I'll come back to this
        </button>
      )}
    </div>
  );

  return (
    <>
      <button type="button" className="block chip" onClick={() => panelBus.setTab('stage')}>
        <Microphone size={15} weight="duotone" /> Pronunciation waiting on the stage
      </button>
      <StagePortal>{inner}</StagePortal>
    </>
  );
}
