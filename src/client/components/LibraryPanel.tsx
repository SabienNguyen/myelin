import { useEffect, useState } from 'react';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react';

type Entry = { book: string; chapter: string; title: string; status: string; error?: string; startedAt?: string };

function elapsed(iso?: string): string {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return mins >= 1 ? ` · started ${mins}m ago` : '';
}

/** Inline-editable book heading: pencil → input; Enter/blur saves (PATCH), Escape cancels. */
function BookTitle({ book, onRenamed }: { book: string; onRenamed: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(book);

  async function save() {
    const name = value.trim();
    setEditing(false);
    if (!name || name === book) { setValue(book); return; }
    const res = await fetch('/api/ingest/book', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ book, name }),
    }).catch(() => null);
    if (res?.ok) onRenamed();
    else setValue(book);
  }

  if (editing) {
    return (
      <input
        className="book-rename"
        value={value}
        autoFocus
        aria-label="Book name"
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { setValue(book); setEditing(false); }
        }}
      />
    );
  }
  return (
    <h3>
      {book}
      <button type="button" className="ghost-btn rename-btn" aria-label={`Rename ${book}`}
        onClick={() => { setValue(book); setEditing(true); }}>
        <PencilSimple size={13} weight="duotone" />
      </button>
    </h3>
  );
}

const POLL_MS = 10_000;

export function LibraryPanel({ visible = true }: { visible?: boolean }) {
  const [queue, setQueue] = useState<Entry[]>([]);
  const [compiling, setCompiling] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  const converting = queue.some((e) => e.status === 'converting');
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const load = () => fetch('/api/ingest/queue').then((r) => r.json())
      .then((q) => { if (!cancelled) setQueue(Array.isArray(q) ? q : []); }).catch(() => {});
    load();
    // Poll fast while a conversion is running so chapters appear the moment it finishes.
    const id = setInterval(load, converting ? 3_000 : POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [visible, compiling, converting, refresh]);

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
        {note && <span className="library-note" role="status">{note}</span>}
      </div>
      {books.map((book) => (
        <section key={book} className="library-book">
          <BookTitle book={book} onRenamed={() => setRefresh((r) => r + 1)} />
          <ul>
            {queue.filter((e) => e.book === book).map((e) => (
              <li key={e.chapter} className={`q-${e.status}`} title={e.error ?? ''}>
                <span className="q-status">{e.status === 'convert-error' ? 'failed' : e.status}</span>
                {e.status === 'converting'
                  ? <span className="converting-row">
                      <span className="dot" /><span className="dot" /><span className="dot" />
                      converting{elapsed(e.startedAt)} — chapters appear here when it finishes
                    </span>
                  : ` ${e.title}`}
                {e.error && <div className="q-error">{e.error}</div>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
