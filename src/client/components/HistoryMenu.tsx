import { useEffect, useRef, useState } from 'react';
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from '@phosphor-icons/react';

type ThreadSummary = { id: string; title: string; updatedAt: string; messages: number };

/** No-dependency relative-time label ("2h ago") for the thread list. */
function relativeTime(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Topbar ghost button + anchored dropdown listing saved conversations (GET /api/threads).
 * Selecting a row or starting a new conversation calls onSelect(id); App remounts Runtime
 * (via `key={threadId}`) to switch context cleanly. */
export function HistoryMenu({ activeId, onSelect }: { activeId: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    fetch('/api/threads')
      .then((r) => r.json())
      .then((t) => setThreads(Array.isArray(t) ? t : []))
      .catch(() => setThreads([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function selectAndClose(id: string) {
    onSelect(id);
    setOpen(false);
  }

  return (
    <div className="history-menu" ref={rootRef}>
      <button
        type="button"
        className="ghost-btn"
        aria-label="Conversation history"
        onClick={() => setOpen((o) => !o)}
      >
        <ClockCounterClockwise size={16} weight="duotone" />
      </button>
      {open && (
        <div className="history-panel">
          <button
            type="button"
            className="history-row history-new"
            onClick={() => selectAndClose(`t-${Date.now().toString(36)}`)}
          >
            + New conversation
          </button>
          {threads.length === 0 && <div className="history-empty">No conversations yet</div>}
          {threads.map((t) => (
            <button
              type="button"
              key={t.id}
              className={`history-row${t.id === activeId ? ' active' : ''}`}
              onClick={() => selectAndClose(t.id)}
            >
              <span className="history-title">{t.title}</span>
              <span className="history-time">{relativeTime(t.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
