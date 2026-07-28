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
import { useState } from 'react';
import { KeyboardIcon as Keyboard } from '@phosphor-icons/react/dist/csr/Keyboard';
import { telex } from '../../../shared/telex.js';

/** Input methods keyed by BCP-47 primary subtag. Each maps a raw keystroke buffer to display text.
 *  Vietnamese is the one shipped; the shape is ready for more (pinyin, etc.). */
const METHODS: Record<string, { label: string; transform: (raw: string) => string }> = {
  vi: { label: 'Telex', transform: telex },
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

  // With the method off (or none), a plain uncontrolled input — full editing, system IME, paste.
  if (!method || !on) {
    return (
      <form className="ime-form" onSubmit={(e) => {
        e.preventDefault();
        onSubmit((new FormData(e.currentTarget).get(name) as string) ?? '');
      }}>
        <input name={name} autoFocus aria-label="answer" />
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
  // shown value can differ from the keys pressed; onChange is a fallback for paste/autofill.
  const value = method.transform(raw);
  return (
    <form className="ime-form" onSubmit={(e) => { e.preventDefault(); onSubmit(value); }}>
      <input
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
      <button type="button" className="ime-toggle is-on" onClick={() => setOn(false)} aria-pressed>
        <Keyboard size={14} weight="duotone" aria-hidden /> {method.label} on
      </button>
      <button type="submit">Answer</button>
    </form>
  );
}
