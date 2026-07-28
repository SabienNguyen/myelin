// offer_write — the tutor, in a teaching mode where it cannot write pages itself (single-writer
// rule keeps writing freeform-only), offers the learner a one-click "write this up" button. The
// old behavior made the learner hunt for the mode selector, switch to freeform, and re-ask; both
// live persona runs stalled on exactly that. Clicking this arms a one-shot write intent and sends
// one message — the server promotes just that turn to freeform, writes the page, and the visible
// mode never changes (writeIntent.ts, chatRoute.ts).
//
// Navigation-class like open_source/speak: it stages no graded work and mints no evidence.
import { useState } from 'react';
// Deep-path import: this project's tsc resolves a truncated view of the package's barrel index
// that drops later icons (see Speak.tsx). The per-icon module carries its own types.
import { NotePencilIcon as NotePencil } from '@phosphor-icons/react/dist/csr/NotePencil';
import { useThreadRuntime } from '@assistant-ui/react';
import { armWriteIntent } from '../../lib/writeIntent.js';

export function OfferWrite({ args, result, addResult }: {
  args: { title: string; why?: string };
  result: any;
  addResult: (r: any) => void;
}) {
  // The THREAD composer, not useComposerRuntime() — inside a tool-rendered message the latter
  // resolves to that message's edit composer ("Composer is not available" until you're editing).
  const thread = useThreadRuntime();
  const [sent, setSent] = useState(false);

  // Once clicked, the button is spent — the write is one turn, and a second click would fire a
  // duplicate write request. The chat's own follow-up turn (the written page, the tutor's reply)
  // is the real confirmation; this just latches the control closed.
  const request = () => {
    if (sent || result) return;
    setSent(true);
    armWriteIntent();
    thread.composer.setText(`Write up “${args.title}” as a page now — save what we've covered.`);
    thread.composer.send();
    addResult({ requested: args.title });
  };

  const done = sent || !!result;
  return (
    <div className="offer-write">
      <button type="button" className="offer-write-btn" onClick={request} disabled={done}>
        <NotePencil size={16} weight="duotone" aria-hidden />
        {done ? <>Writing “{args.title}”…</> : <>Write “{args.title}” up as a page</>}
      </button>
      {args.why && !done && <p className="offer-write-why">{args.why}</p>}
    </div>
  );
}
