// open_source — the tutor brings the learner TO the artifact. The call resolves a ledger title
// to its raw path client-side and opens the source reader, then reports back so the tutor can
// say "read section 3.2" knowing the section is on screen. No grading, no evidence: this is
// navigation, and the chip it leaves in the thread is a record of where the tutor took you.
import { useEffect, useRef } from 'react';
import { BookOpenTextIcon as BookOpenText } from '@phosphor-icons/react';
import { panelBus } from '../../lib/panelBus.js';

export function OpenSource({ args, result, addResult }: {
  args: { title: string }; result: any; addResult: (r: any) => void;
}) {
  const fired = useRef(false);
  useEffect(() => {
    if (result || fired.current) return;
    fired.current = true;
    (async () => {
      try {
        const queue: { book: string; title: string; chapter: string; status: string }[] =
          await fetch('/api/ingest/queue').then((r) => r.json());
        const want = args.title.trim().toLowerCase();
        const hit = (queue ?? []).find((e) => e.chapter?.startsWith('raw/')
          && (e.title?.toLowerCase().includes(want) || e.book?.toLowerCase().includes(want)
            || want.includes(e.title?.toLowerCase() ?? ' ')));
        if (!hit) { addResult({ error: `no ingested source matches “${args.title}”` }); return; }
        panelBus.openSource(hit.chapter, hit.title);
        // The chapter path rides in the result so the chip can RE-open the reader after a
        // reload — openSource is an ephemeral event, and a chip that only switched tabs left
        // the Page panel readerless (caught driving select-to-ask on a reloaded thread).
        addResult({ opened: hit.title, chapter: hit.chapter });
      } catch (e: any) {
        addResult({ error: String(e?.message ?? e) });
      }
    })();
  }, [result, args.title, addResult]);

  if (result?.error) return <span className="tool-note failed">✗ {result.error}</span>;
  return (
    <button
      type="button"
      className="block chip"
      // The chip stays useful after the moment: clicking it RE-OPENS the source view — with the
      // stored chapter when the result carries one, else by re-resolving the title (results
      // saved before the chapter rode along). setTab alone left a readerless Page panel after a
      // reload, because openSource is an ephemeral event no one replays.
      onClick={async () => {
        if (!result?.opened) return;
        if (result.chapter) { panelBus.openSource(result.chapter, result.opened); return; }
        try {
          const queue: { title: string; chapter: string }[] = await fetch('/api/ingest/queue').then((r) => r.json());
          const hit = (queue ?? []).find((e) => e.title === result.opened && e.chapter?.startsWith('raw/'));
          if (hit) panelBus.openSource(hit.chapter, hit.title);
          else panelBus.setTab('page');
        } catch { panelBus.setTab('page'); }
      }}
    >
      <BookOpenText size={15} weight="duotone" />
      {result?.opened ? ` Reading: ${result.opened} — on the Page tab` : ` Opening ${args.title}…`}
    </button>
  );
}
