// speak — the tutor attaches a "hear this" control to a word or phrase, spoken by the browser's
// own speech engine (Web Speech API, in Chromium/Electron already). Built for tone languages: a
// text tutor can teach that "ma" has six tones and what each diacritic means, but until this it
// could never let the learner HEAR the difference (a live Vietnamese sitting named the gap
// exactly). Navigation-class like open_source — hearing a word is not evidence you can say it,
// so it mints nothing.
//
// Degrade-loudly: if the OS has no voice for the requested language, the button says so rather
// than mispronouncing Vietnamese in a US-English voice. That honesty is the whole reason the
// tutor is allowed to offer audio at all.
import { useEffect, useRef, useState } from 'react';
// Deep-path imports (not the barrel): the package's top-level index.d.ts is enormous and this
// project's tsc resolves a truncated view of it that stops before the "Sp…" icons — SigmaIcon
// resolves, SpeakerHighIcon does not. The per-icon module under the package's `exports` map
// carries its own types and resolves cleanly.
import { SpeakerHighIcon as SpeakerHigh } from '@phosphor-icons/react/dist/csr/SpeakerHigh';
import { SpeakerSlashIcon as SpeakerSlash } from '@phosphor-icons/react/dist/csr/SpeakerSlash';

/** A voice whose BCP-47 tag matches the requested language by primary subtag ("vi" matches
 *  "vi-VN"), preferring an exact tag when several exist. Exported for the unit test, which drives
 *  it with a plain array instead of the live voice list. */
export function pickVoice<T extends { lang: string }>(voices: T[], lang: string): T | null {
  const want = lang.toLowerCase();
  const primary = want.split('-')[0];
  const matches = voices.filter((v) => {
    const have = (v.lang ?? '').toLowerCase().replace('_', '-');
    return have === want || have.split('-')[0] === primary;
  });
  if (matches.length === 0) return null;
  return matches.find((v) => (v.lang ?? '').toLowerCase().replace('_', '-') === want) ?? matches[0];
}

export function Speak({ args, result, addResult }: {
  args: { text: string; lang: string; gloss?: string };
  result: any;
  addResult: (r: any) => void;
}) {
  // getVoices() is empty until the async voiceschanged event on first load, so track it in state
  // rather than reading once. null = still discovering; [] would wrongly read as "no voices".
  const [voices, setVoices] = useState<SpeechSynthesisVoice[] | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const reported = useRef(false);

  useEffect(() => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth) { setVoices([]); return; }
    const load = () => setVoices(synth.getVoices());
    load();
    synth.addEventListener?.('voiceschanged', load);
    return () => synth.removeEventListener?.('voiceschanged', load);
  }, []);

  const voice = voices ? pickVoice(voices, args.lang) : null;
  const available = voices !== null && voice !== null;

  // Report availability ONCE, so the tutor's next turn knows whether the learner could actually
  // hear it — and can fall back to "find a native recording" honestly when they couldn't.
  useEffect(() => {
    if (voices === null || result || reported.current) return;
    reported.current = true;
    addResult({ available, spoke: args.text });
  }, [voices, available, result, addResult, args.text]);

  const speak = () => {
    const synth = window.speechSynthesis;
    if (!synth || !voice) return;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(args.text);
    utter.voice = voice;
    utter.lang = voice.lang;
    utter.rate = 0.85; // a hair slow — a learner is parsing tones, not listening for pleasure
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(utter);
  };

  if (voices !== null && !available) {
    return (
      <span className="speak-chip speak-unavailable" title={`no ${args.lang} voice installed`}>
        <SpeakerSlash size={15} weight="duotone" aria-hidden />
        <span className="speak-text">{args.text}</span>
        {args.gloss && <span className="speak-gloss">{args.gloss}</span>}
        <span className="speak-note">no {args.lang} voice on this device — use a native recording</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      className={`speak-chip${speaking ? ' is-speaking' : ''}`}
      onClick={speak}
      disabled={!available}
      aria-label={`hear "${args.text}"${args.gloss ? ` — ${args.gloss}` : ''}`}
    >
      <SpeakerHigh size={15} weight="duotone" aria-hidden />
      <span className="speak-text">{args.text}</span>
      {args.gloss && <span className="speak-gloss">{args.gloss}</span>}
    </button>
  );
}
