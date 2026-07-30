// The ONE way material enters the app. There used to be two — "Add book" (a topbar file input)
// and "Add repo" (an input+button inside the Library) — which meant the learner had to already
// know the app's internal taxonomy to add anything. One control, routed by what was given:
//   a file (browsed or dropped)          -> POST /api/ingest        (document conversion)
//   a pasted YouTube URL                 -> POST /api/ingest        (caption transcript -> paper)
//   a pasted git URL / local folder path -> POST /api/ingest/repo   (repo ingestion)
// The server decides what the document becomes (book chapters, a paper, or a banked problem set).
//
// The second control below answers the case where the learner has no url yet: "who should I read
// about X". It belongs HERE and not in the chat because a recommendation must end in an ARTIFACT,
// not in a lesson — every row's Add goes back out through the same doors above. The list itself is
// built by POST /api/curate with no model involved, and each row's reasons are index facts; this
// component only renders them, and must never summarise or editorialise them.
import { useEffect, useRef, useState } from 'react';
import { panelBus } from '../lib/panelBus.js';
import { isVideoUrl } from '../../shared/videoUrl.js';

const FILE_KINDS = '.pdf, .epub, .docx, .md, .txt';

/** POST /api/curate's shape — server: curate.ts. `why` is mechanical, `by` is verbatim. */
type Recommendation = {
  kind: 'paper' | 'video';
  title: string; by: string[]; url: string; why: string[]; knownAuthor: boolean;
};
type ReadingList = { topic: string; recommendations: Recommendation[]; sourceErrors: string[] };

export function AddMaterial() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [dragging, setDragging] = useState(false);
  const [topic, setTopic] = useState('');
  const [curating, setCurating] = useState(false);
  const [list, setList] = useState<ReadingList | null>(null);
  const [curateError, setCurateError] = useState<string | null>(null);
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
    // One field, routed by what was pasted: a video URL goes to caption ingestion (its transcript
    // becomes a paper), a local FILE path goes to book ingestion, everything else stays on the
    // repo path. Same door, no extra button. The file case exists because the audit typed a
    // notes file's path here and the repo route rejected its extension with "rename the repo".
    // Ends in a file extension (and isn't a URL or git@ remote). The length bound is 10, not 5:
    // `.markdown` is 8 characters and the server converts it (convert.ts, and the file-browse accept
    // list carries it) — a 5-cap silently sent a pasted `.markdown` PATH to the repo route, the very
    // "repo route rejects a file's extension" error this file-path branch was added to avoid.
    const looksLikeFilePath = !/^[a-z]+:\/\//i.test(trimmed) && !trimmed.startsWith('git@')
      && /\.[A-Za-z0-9]{1,10}$/.test(trimmed);
    if (looksLikeFilePath) {
      try {
        const res = await fetch('/api/ingest', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: trimmed }),
        });
        const data = await res.json();
        if (res.ok) {
          setStatus(`${data.book}: converting in the background — see Library`);
          setSource('');
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
      return;
    }
    if (isVideoUrl(trimmed)) {
      try {
        const res = await fetch('/api/ingest', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: trimmed }),
        });
        const data = await res.json();
        if (res.ok) {
          setStatus(`${data.book}: transcript fetched — compiling in the background, see Library`);
          setSource('');
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
      return;
    }
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

  async function askWhoToRead(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = topic.trim();
    if (!trimmed || curating) return;
    setCurating(true);
    setCurateError(null);
    setList(null);
    try {
      const res = await fetch('/api/curate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: trimmed }),
      });
      const data = await res.json();
      if (res.ok) setList(data as ReadingList);
      else setCurateError(`could not build a list: ${data.error ?? res.statusText}`);
    } catch (err: any) {
      setCurateError(`could not build a list: ${err?.message ?? err}`);
    } finally {
      setCurating(false);
    }
  }

  // A recommendation is ingested through the SAME JSON `url` door a pasted link uses — papers and
  // videos alike, since the server routes videos by isVideoUrl. `authors` rides along because the
  // index reported that byline for this exact url, and provenance.ts reconciles it against whatever
  // the artifact's own platform says rather than taking either on faith.
  async function addRecommendation(rec: Recommendation) {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: rec.url, authors: rec.by }),
      });
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
            <label htmlFor="add-material-source">Paste a git URL, a YouTube link, or a local folder path</label>
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
          <form className="add-material-curate" onSubmit={askWhoToRead}>
            <label htmlFor="add-material-topic">Not sure where to start? Ask who to read</label>
            <input
              id="add-material-topic"
              type="text"
              value={topic}
              placeholder="a topic, e.g. spaced repetition"
              disabled={curating}
              onChange={(e) => setTopic(e.target.value)}
            />
            <button type="submit" disabled={curating || !topic.trim()}>
              {curating ? 'Looking…' : 'Ask'}
            </button>
          </form>
          {curateError && <p className="curate-note" role="status">{curateError}</p>}
          {list && (
            <div className="curate-results" role="status">
              {/* An index that could not be reached is reported even when the other one returned
                  rows — a short list because Crossref was down must not read as "that is all
                  there is". */}
              {list.sourceErrors.length > 0 && (
                <p className="curate-note">could not reach {list.sourceErrors.join('; ')}</p>
              )}
              {list.recommendations.length === 0 && list.sourceErrors.length === 0 && (
                <p className="curate-note">nothing found for “{list.topic}”</p>
              )}
              {list.recommendations.length > 0 && (
                <ul className="curate-list">
                  {list.recommendations.map((rec) => (
                    <li className="curate-row" key={rec.url}>
                      <div className="curate-row-text">
                        {/* The humans lead. You choose material by who made it, so the byline
                            outranks the title typographically rather than trailing it. */}
                        {rec.by.length > 0 && <p className="curate-by">{rec.by.join(', ')}</p>}
                        <p className="curate-title">{rec.title}</p>
                        {rec.knownAuthor && <p className="curate-known">you’ve learned from them</p>}
                        <p className="curate-why">{rec.why.join(' · ')}</p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Add ${rec.title}`}
                        disabled={busy}
                        onClick={() => void addRecommendation(rec)}
                      >
                        Add
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {/* Failures leave the panel open, so they report HERE, where the user is looking and
              long text can wrap — the yt-dlp install hint rendered as one unwrapped topbar line
              running off the window edge before this. */}
          {status && <p className="ingest-status" role="status">{status}</p>}
        </div>
      )}
      {/* Success closes the panel; its short status lands beside the button, capped so no
          message can displace the topbar again. */}
      {status && !open && <span className="ingest-status" role="status">{status}</span>}
    </div>
  );
}
