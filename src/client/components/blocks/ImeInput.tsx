// A text field with a language input method, so a learner can type a target language from an
// ASCII keyboard — "the correct keyboard for the language" they asked for. Today it carries
// Vietnamese Telex (telex.ts): the field keeps the RAW keystrokes the learner types and shows the
// transliteration (`vieejt` → `việt`), because Telex is a stateful replay, not a per-character
// map. Languages with no input method fall through to a plain input.
//
// A visible toggle (default on when a method exists) always lets the learner drop back to a system
// IME — the honest escape hatch, the same instinct behind speak's degrade-loudly path. Mid-string
// editing is deliberately out of scope for v1: the field appends and backspaces at the end, which
// is how a learner types an answer; the toggle covers the paste / mid-edit case.
import { useRef, useState } from 'react';
import { KeyboardIcon as Keyboard } from '@phosphor-icons/react/dist/csr/Keyboard';
import { telex } from '../../../shared/telex.js';
import { pinyin } from '../../../shared/pinyin.js';

/** Input methods keyed by BCP-47 primary subtag. Each maps a raw keystroke buffer to display text:
 *  Vietnamese Telex (vieejt→việt) and Mandarin Pinyin tone input (ni3→nǐ). Both are ASCII→toned
 *  transliterations, the shape non-Latin scripts (a virtual keyboard) could extend later. */
const METHODS: Record<string, { label: string; transform: (raw: string) => string }> = {
  vi: { label: 'Telex', transform: telex },
  zh: { label: 'Pinyin', transform: pinyin },
};

export function imeFor(lang: string | undefined) {
  return lang ? METHODS[lang.toLowerCase().split('-')[0]] : undefined;
}

export function ImeInput({ lang, name, onSubmit }: {
  lang?: string; name: string; onSubmit: (value: string) => void;
}) {
  const method = imeFor(lang);
  const [on, setOn] = useState(true);
  const [raw, setRaw] = useState('');
  // What the transliterated field held when the learner last toggled the method OFF, so the plain
  // field can start from their work instead of blank — the "toggle covers the mid-edit case" promise.
  const seed = useRef('');
  const value = method ? method.transform(raw) : '';

  // With the method off (or none), a plain uncontrolled input — full editing, system IME, paste.
  // A distinct `key` from the transliterating input below is deliberate: without it React reuses
  // the same DOM node across the toggle and logs a controlled→uncontrolled warning; a separate key
  // mounts a clean uncontrolled field, seeded via defaultValue so the typed text carries over.
  if (!method || !on) {
    return (
      <form className="ime-form" onSubmit={(e) => {
        e.preventDefault();
        onSubmit((new FormData(e.currentTarget).get(name) as string) ?? '');
      }}>
        <input key="plain" name={name} autoFocus aria-label="answer" defaultValue={seed.current} />
        {method && (
          <button type="button" className="ime-toggle" onClick={() => setOn(true)} aria-pressed={false}>
            <Keyboard size={14} weight="duotone" aria-hidden /> {method.label} off
          </button>
        )}
        <button type="submit">Answer</button>
      </form>
    );
  }

  // Method on: hold the raw keystrokes, display the transliteration. keydown owns the buffer so the
  // shown value can differ from the keys pressed. Paste/mid-edit is handled by toggling the method
  // off (which seeds the plain field with this text), not here — Telex is a stateful replay of
  // keystrokes, so there is no raw buffer a pasted string could correspond to.
  return (
    <form className="ime-form" onSubmit={(e) => { e.preventDefault(); onSubmit(value); }}>
      <input
        key="ime"
        name={name}
        autoFocus
        aria-label={`answer (${method.label} input)`}
        value={value}
        onChange={() => { /* controlled by keydown; ignore synthetic value writes */ }}
        onKeyDown={(e) => {
          if (e.key === 'Backspace') { e.preventDefault(); setRaw((r) => r.slice(0, -1)); }
          else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setRaw((r) => r + e.key); }
          // Enter, arrows, Tab, etc. fall through to the form / browser.
        }}
      />
      <button type="button" className="ime-toggle is-on" onClick={() => { seed.current = value; setOn(false); }} aria-pressed>
        <Keyboard size={14} weight="duotone" aria-hidden /> {method.label} on
      </button>
      <button type="submit">Answer</button>
    </form>
  );
}
