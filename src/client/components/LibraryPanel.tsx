import { useEffect, useState } from 'react';

type Entry = { book: string; chapter: string; title: string; status: string; error?: string };

const POLL_MS = 10_000;

export function LibraryPanel({ visible = true }: { visible?: boolean }) {
  const [queue, setQueue] = useState<Entry[]>([]);
  const [compiling, setCompiling] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const load = () => fetch('/api/ingest/queue').then((r) => r.json())
      .then((q) => { if (!cancelled) setQueue(Array.isArray(q) ? q : []); }).catch(() => {});
    load();
    const id = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [visible, compiling]);

  async function compile(n: number) {
    setCompiling(true);
    setNote(null);
    try {
      const res = await fetch('/api/ingest/compile', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n }),
      });
      const data = await res.json();
      setNote(res.ok ? `Compiled ${data.compiled}, failed ${data.failed}` : `Compile failed: ${data.error ?? res.statusText}`);
    } catch (e: any) {
      setNote(`Compile failed: ${e?.message ?? e}`);
    } finally {
      setCompiling(false);
    }
  }

  if (queue.length === 0) {
    return <p className="empty">No books yet — use “Add book” in the top bar, or ask the tutor (freeform) to pull in a paper.</p>;
  }

  const pending = queue.filter((e) => e.status === 'pending').length;
  const books = [...new Set(queue.map((e) => e.book))];

  return (
    <div className="library-panel">
      <div className="library-actions">
        <button
          type="button"
          className="primary"
          disabled={compiling || pending === 0}
          onClick={() => compile(3)}
        >
          {compiling ? 'Compiling… (this takes minutes on local models)' : `Compile next ${Math.min(3, pending) || 0} of ${pending}`}
        </button>
        {note && <span className="library-note">{note}</span>}
      </div>
      {books.map((book) => (
        <section key={book} className="library-book">
          <h3>{book}</h3>
          <ul>
            {queue.filter((e) => e.book === book).map((e) => (
              <li key={e.chapter} className={`q-${e.status}`} title={e.error ?? ''}>
                <span className="q-status">{e.status}</span> {e.title}
                {e.error && <div className="q-error">{e.error}</div>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
