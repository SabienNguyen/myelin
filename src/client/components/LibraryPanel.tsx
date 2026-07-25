import { useEffect, useRef, useState } from 'react';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react';
import { PracticePanel } from './PracticePanel.js';
import { PathsSection } from './PathsSection.js';

type Entry = {
  book: string; chapter: string; title: string; status: string; error?: string; startedAt?: string;
  progress?: { pagesDone: number; pagesTotal: number | null };
  mode?: string; // 'repo' for a B2c repo-ingest placeholder — plain book chapters leave this unset
  phase?: string; // repo-ingest placeholder's human-readable phase text (cloning/docs/mining/done)
};

function elapsed(iso?: string): string {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return mins >= 1 ? ` · started ${mins}m ago` : '';
}

/** Converting placeholder row: shows a determinate "N/M pages" progress bar once the incremental
 * converter has reported a known page count, else falls back to the original elapsed-time text
 * (unknown page count — EPUB/DOCX, or a PDF pdfPageCount() couldn't read). */
function ConvertingRow({ entry }: { entry: Entry }) {
  const { pagesDone, pagesTotal } = entry.progress ?? { pagesDone: 0, pagesTotal: null };
  const dots = <><span className="dot" /><span className="dot" /><span className="dot" /></>;

  if (pagesTotal) {
    const pct = Math.max(0, Math.min(100, Math.round((pagesDone / pagesTotal) * 100)));
    return (
      <span className="converting-row">
        {dots}
        converting · {pagesDone}/{pagesTotal} pages
        <span className="q-progress-bar"><span className="q-progress-bar-fill" style={{ width: `${pct}%` }} /></span>
      </span>
    );
  }
  return (
    <span className="converting-row">
      {dots}
      converting{elapsed(entry.startedAt)} — chapters appear here when it finishes
    </span>
  );
}

/** B2c repo-ingest placeholder row: distinct badge + the current phase text ('cloning',
 * 'docs: N queued', 'mining…', 'mined P/C passed', or the final 'pages: N queued, exercises: P'
 * summary once done) in place of ConvertingRow's page-count progress bar, which doesn't apply to
 * a multi-phase repo ingest. */
function RepoIngestRow({ entry }: { entry: Entry }) {
  const busy = entry.status === 'converting';
  return (
    <span className="repo-ingest-row">
      <span className="repo-badge">repo</span>
      {busy && <><span className="dot" /><span className="dot" /><span className="dot" /></>}
      {entry.phase ?? entry.title}
    </span>
  );
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

/** B2c: "Add repo" affordance (paired with the topbar's "Add book" — git URL or absolute local
 * path, ingested via POST /api/ingest/repo). Kept self-contained in LibraryPanel rather than
 * threaded through App.tsx's own upload state, since the repo queue row it produces already lives
 * here. */
function AddRepoForm({ onQueued }: { onQueued: () => void }) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const source = value.trim();
    if (!source || submitting) return;
    setSubmitting(true);
    setNote(null);
    try {
      const res = await fetch('/api/ingest/repo', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setValue('');
        setNote(`${data.name}: ingesting in the background`);
        onQueued();
      } else {
        setNote(`Add repo failed: ${data.error ?? res.statusText}`);
      }
    } catch (err: any) {
      setNote(`Add repo failed: ${err?.message ?? err}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="add-repo-form" onSubmit={submit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="git URL or local path"
        aria-label="Repo URL or path"
        disabled={submitting}
      />
      <button type="submit" disabled={submitting || !value.trim()}>
        {submitting ? 'Adding…' : 'Add repo'}
      </button>
      {note && <span className="library-note" role="status">{note}</span>}
    </form>
  );
}

const POLL_MS = 10_000;

export function LibraryPanel({ visible = true }: { visible?: boolean }) {
  // null = not loaded yet, distinct from [] = loaded and genuinely empty. Starting at [] meant the
  // first render asserted "No books yet" before the fetch had even been issued, so every visit to
  // the Library flashed a false statement at anyone who does have books.
  const [queue, setQueue] = useState<Entry[] | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  // A ref, not `queue` in the effect's deps: this effect SETS queue, so depending on it would
  // tear down and rebuild the poll interval on every single response.
  const loadedOnceRef = useRef(false);
  const [compiling, setCompiling] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [autoCompile, setAutoCompile] = useState(false);

  const converting = (queue ?? []).some((e) => e.status === 'converting');
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    // Swallowing the error was harmless while `queue` started at [] — the panel just showed "no
    // books". Now that null means "not asked yet", swallowing would pin it on "Loading…" forever,
    // which is the same defect PagePanel and GraphPanel already had to fix.
    const load = () => fetch('/api/ingest/queue')
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((q) => {
        if (cancelled) return;
        loadedOnceRef.current = true;
        setQueue(Array.isArray(q) ? q : []);
        setQueueError(null);
      })
      .catch(() => {
        // Only replace a view that was never populated; a failed background poll must not throw
        // away a library the learner is already looking at.
        if (!cancelled && !loadedOnceRef.current) setQueueError('Couldn’t load your library — the harness didn’t answer.');
      });
    load();
    // Poll fast while a conversion is running so chapters appear the moment it finishes.
    const id = setInterval(load, converting ? 3_000 : POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [visible, compiling, converting, refresh]);

  useEffect(() => {
    fetch('/api/status').then((r) => r.json())
      .then((s) => setAutoCompile(Boolean(s?.autoCompile))).catch(() => {});
  }, []);

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

  if (queue === null) {
    return (
      <div className="library-panel">
        {queueError
          ? <p className="panel-error" role="status">{queueError}</p>
          : <p className="empty">Loading your library…</p>}
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <div className="library-panel">
        {/* Paths belong in BOTH branches. This one — an empty compile queue — is the new learner's
            state, and it is exactly when a syllabus matters most: they may have a path and no books
            at all. Omitting it here hid the whole feature for the default case. */}
        <PathsSection visible={visible} />
        <AddRepoForm onQueued={() => setRefresh((r) => r + 1)} />
        <p className="empty">No books yet — use “Add book” in the top bar, or ask the tutor (freeform) to pull in a paper.</p>
        <PracticePanel visible={visible} />
      </div>
    );
  }

  const pending = queue.filter((e) => e.status === 'pending').length;
  const books = [...new Set(queue.map((e) => e.book))];

  return (
    <div className="library-panel">
      {/* Paths first — the syllabus is the frame the books and practice rows sit inside. */}
      <PathsSection visible={visible} />
      <AddRepoForm onQueued={() => setRefresh((r) => r + 1)} />
      <div className="library-actions">
        <button
          type="button"
          className="primary"
          disabled={compiling || pending === 0}
          onClick={() => compile(3)}
        >
          {compiling ? 'Compiling… (this takes minutes on local models)' : `Compile now (${Math.min(3, pending) || 0} of ${pending})`}
        </button>
        {note && <span className="library-note" role="status">{note}</span>}
        {!note && pending > 0 && autoCompile
          && <span className="library-note library-autocompile-note" role="status">auto-compiling in the background</span>}
      </div>
      {books.map((book) => (
        <section key={book} className="library-book">
          <BookTitle book={book} onRenamed={() => setRefresh((r) => r + 1)} />
          <ul>
            {queue.filter((e) => e.book === book).map((e) => (
              <li key={e.chapter} className={`q-${e.status}${e.mode === 'repo' ? ' q-repo' : ''}`} title={e.error ?? ''}>
                <span className="q-status">{e.status === 'convert-error' ? 'failed' : e.status}</span>
                {e.mode === 'repo' ? <RepoIngestRow entry={e} />
                  : e.status === 'converting' ? <ConvertingRow entry={e} />
                    : ` ${e.title}`}
                {e.error && <div className="q-error">{e.error}</div>}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <PracticePanel visible={visible} />
    </div>
  );
}
