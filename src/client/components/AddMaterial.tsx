// The ONE way material enters the app. There used to be two — "Add book" (a topbar file input)
// and "Add repo" (an input+button inside the Library) — which meant the learner had to already
// know the app's internal taxonomy to add anything. One control, routed by what was given:
//   a file (browsed or dropped)          -> POST /api/ingest        (document conversion)
//   a pasted git URL / local folder path -> POST /api/ingest/repo   (repo ingestion)
// The server decides what the document becomes (book chapters, a paper, or a banked problem set).
import { useEffect, useRef, useState } from 'react';
import { panelBus } from '../lib/panelBus.js';

const FILE_KINDS = '.pdf, .epub, .docx, .md, .txt';

export function AddMaterial() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Dismissal mirrors HistoryMenu: Escape closes and returns focus to the trigger; a click
  // anywhere outside just closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); }
    };
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onClick); };
  }, [open]);

  useEffect(() => { if (open) sourceRef.current?.focus(); }, [open]);

  async function ingestFile(file: File) {
    setBusy(true);
    setStatus(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/ingest', { method: 'POST', body: form });
      const data = await res.json();
      if (res.ok) {
        setStatus(`${data.book}: converting in the background — see Library`);
        setOpen(false);
        panelBus.setTab('library');
      } else {
        setStatus(`ingest failed: ${data.error ?? res.statusText}`);
      }
    } catch (err: any) {
      setStatus(`ingest failed: ${err?.message ?? err}`);
    } finally {
      setBusy(false);
    }
  }

  async function ingestSource(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = source.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch('/api/ingest/repo', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSource('');
        setStatus(`${data.name}: ingesting in the background`);
        setOpen(false);
        panelBus.setTab('library');
      } else {
        setStatus(`add failed: ${data.error ?? res.statusText}`);
      }
    } catch (err: any) {
      setStatus(`add failed: ${err?.message ?? err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="add-material" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? 'Adding…' : 'Add material'}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Add material"
          className={`add-material-panel${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void ingestFile(file);
          }}
        >
          <form onSubmit={ingestSource}>
            <label htmlFor="add-material-source">Paste a git URL or local folder path</label>
            <input
              id="add-material-source"
              ref={sourceRef}
              type="text"
              value={source}
              placeholder="https://… or /home/…"
              disabled={busy}
              onChange={(e) => setSource(e.target.value)}
            />
            <button type="submit" disabled={busy || !source.trim()}>Add</button>
          </form>
          <div className="add-material-file">
            <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
              Browse files…
            </button>
            <span className="add-material-hint">
              or drop one here — a book, paper, problem set, or notes ({FILE_KINDS})
            </span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.epub,.docx,.md,.markdown,.txt"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void ingestFile(file);
            }}
          />
        </div>
      )}
      {status && <span className="ingest-status" role="status">{status}</span>}
    </div>
  );
}
