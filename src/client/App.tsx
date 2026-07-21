import { useEffect, useRef, useState } from 'react';
import { BookOpenTextIcon as BookOpenText } from '@phosphor-icons/react';
import { Runtime } from './runtime.js';
import { Thread } from './components/Thread.js';
import { SidePanel } from './components/SidePanel.js';
import { TopbarStatus } from './components/TopbarStatus.js';
import { HistoryMenu } from './components/HistoryMenu.js';
import { FocusRail } from './components/FocusRail.js';
import { panelBus } from './lib/panelBus.js';
import { parseHash, serializeHash } from './lib/urlState.js';

export function App() {
  const [mode, setMode] = useState('learn');
  const [threadId, setThreadId] = useState(() => parseHash(location.hash).threadId);
  const [ingesting, setIngesting] = useState(false);
  const [ingestStatus, setIngestStatus] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // P1 (docs/superpowers/plans/2026-07-20-gap-integration.md): IDE focus mode. A code_exercise
  // block (CodeExercise.tsx) emits panelBus `focusMode` on mount-with-no-result / unmount; App
  // owns the resulting `.app.focus-mode` class (documented choice — least invasive against the
  // existing SidePanel/App structure: a CSS grid change, not a new layout component tree). `peek`
  // is local UI state (not part of the bus event) letting the learner glance at chat without
  // exiting focus mode; it always resets when focus mode itself turns off, so the next exercise
  // starts collapsed again.
  const [focusMode, setFocusMode] = useState(false);
  const [peek, setPeek] = useState(false);
  useEffect(() => panelBus.subscribe((e) => { if (e.type === 'focusMode') setFocusMode(e.on); }), []);
  useEffect(() => { if (!focusMode) setPeek(false); }, [focusMode]);

  // Deep-linking (T27): the URL hash encodes `#/t/<threadId>[/<tab>|/page/<slug>]`. App owns
  // only the threadId slice — SidePanel owns tab/page and re-parses the hash to preserve this
  // piece when it writes its own. Thread switches push a new history entry (unlike SidePanel's
  // tab flips, which replace) so Back returns to the prior conversation.
  function selectThread(id: string) {
    setThreadId(id);
    const current = parseHash(location.hash);
    const nextHash = serializeHash({ ...current, threadId: id });
    if (nextHash !== location.hash) history.pushState(null, '', nextHash);
  }

  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseHash(location.hash);
      setThreadId((prev) => (parsed.threadId !== prev ? parsed.threadId : prev));
    };
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onHashChange);
    };
  }, []);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setIngesting(true);
    setIngestStatus(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/ingest', { method: 'POST', body: form });
      const data = await res.json();
      setIngestStatus(res.ok ? `${data.book}: converting in the background — see Library` : `ingest failed: ${data.error ?? res.statusText}`);
      if (res.ok) panelBus.setTab('library');
    } catch (err: any) {
      setIngestStatus(`ingest failed: ${err?.message ?? err}`);
    } finally {
      setIngesting(false);
    }
  }

  const appClass = ['app', focusMode && 'focus-mode', focusMode && peek && 'peek'].filter(Boolean).join(' ');

  return (
    <Runtime key={threadId} mode={mode} threadId={threadId}>
      <div className={appClass}>
        <header className="topbar">
          <h1><BookOpenText size={20} weight="duotone" /> Loreweaver</h1>
          <HistoryMenu activeId={threadId} onSelect={selectThread} />
          <TopbarStatus />
          <button type="button" onClick={() => fileInput.current?.click()} disabled={ingesting}>
            {ingesting ? 'Converting…' : 'Add book'}
          </button>
          <input
            ref={fileInput} type="file" accept=".pdf,.epub,.docx" hidden onChange={handleFile}
          />
          {ingestStatus && <span className="ingest-status" role="status">{ingestStatus}</span>}
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {['learn', 'review', 'quiz', 'freeform'].map((m) => <option key={m}>{m}</option>)}
          </select>
        </header>
        <main className="workspace">
          <div className="thread-column">
            <FocusRail peek={peek} onTogglePeek={() => setPeek((p) => !p)} />
            <Thread />
          </div>
          <SidePanel />
        </main>
      </div>
    </Runtime>
  );
}
