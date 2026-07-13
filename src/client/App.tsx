import { useRef, useState } from 'react';
import { BookOpenTextIcon as BookOpenText } from '@phosphor-icons/react';
import { Runtime } from './runtime.js';
import { Thread } from './components/Thread.js';
import { SidePanel } from './components/SidePanel.js';
import { TopbarStatus } from './components/TopbarStatus.js';

export function App() {
  const [mode, setMode] = useState('learn');
  const [ingesting, setIngesting] = useState(false);
  const [ingestStatus, setIngestStatus] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

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
      setIngestStatus(res.ok ? `${data.book}: ${data.chapters} chapters queued` : `ingest failed: ${data.error ?? res.statusText}`);
    } catch (err: any) {
      setIngestStatus(`ingest failed: ${err?.message ?? err}`);
    } finally {
      setIngesting(false);
    }
  }

  return (
    <Runtime mode={mode}>
      <div className="app">
        <header className="topbar">
          <h1><BookOpenText size={20} weight="duotone" /> Loreweaver</h1>
          <TopbarStatus />
          <button type="button" onClick={() => fileInput.current?.click()} disabled={ingesting}>
            {ingesting ? 'Converting…' : 'Add book'}
          </button>
          <input
            ref={fileInput} type="file" accept=".pdf,.epub,.docx" hidden onChange={handleFile}
          />
          {ingestStatus && <span className="ingest-status">{ingestStatus}</span>}
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {['learn', 'review', 'quiz', 'freeform'].map((m) => <option key={m}>{m}</option>)}
          </select>
        </header>
        <main className="workspace">
          <Thread />
          <SidePanel />
        </main>
      </div>
    </Runtime>
  );
}
