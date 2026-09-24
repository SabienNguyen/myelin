import { useCallback, useEffect, useRef, useState } from 'react';
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from '@phosphor-icons/react';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { deleteThread, getThreads, type ThreadRow, type ThreadSummary } from '../lib/api.js';
import { panelBus } from '../lib/panelBus.js';
import { useMenu } from '../lib/useMenu.js';

/** Rows the menu renders before handing the rest to the command palette's search: a few hundred
 *  conversations made one long list that arrow keys stepped through row by row. */
const MENU_ROWS = 50;

/** No-dependency relative-time label ("2h ago") for the thread list. '' for a date that does not
 *  parse (a hand-edited notebook without createdAt read "active NaNd ago"). */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The inline confirm before DELETE /api/thread/:id — the notebook's alertdialog pattern. Used by
 *  HistoryMenu and the notebook view's conversation rows. */
export function ConfirmDeleteThread({ thread, onDeleted, onCancel }: {
  thread: Pick<ThreadRow, 'id' | 'title'>; onDeleted: () => void; onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const questionId = `thread-del-q-${thread.id}`;
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteThread(thread.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }
  return (
    <div
      role="alertdialog"
      aria-labelledby={questionId}
      className="nb-confirm thread-confirm"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
    >
      <p id={questionId}>Delete “{thread.title}”? Its messages cannot be recovered.</p>
      <div className="nb-actions">
        <button type="button" className="nb-delete" disabled={busy} onClick={remove}>Delete conversation</button>
        <button type="button" onClick={onCancel} autoFocus>Cancel</button>
      </div>
      {error && <p className="panel-error" role="alert">{error}</p>}
    </div>
  );
}

/** Topbar ghost button + anchored dropdown listing saved conversations (GET /api/threads).
 * Selecting a row or starting a new conversation calls onSelect(id); App remounts Runtime
 * (via `key={threadId}`) to switch context cleanly. */
export function HistoryMenu({ activeId, onSelect }: { activeId: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setOpen(false); setConfirming(null); }, []);
  useMenu({ open, close, rootRef, panelRef, triggerRef, paused: confirming !== null });

  useEffect(() => {
    if (!open) return;
    // Closing and reopening while the first request is in flight must not let the stale list land
    // over the fresh one.
    let cancelled = false;
    setError(null);
    getThreads()
      .then((t) => { if (!cancelled) setThreads(Array.isArray(t) ? t : []); })
      .catch((e) => { if (!cancelled) { setThreads([]); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { cancelled = true; };
  }, [open]);

  function selectAndClose(id: string) {
    onSelect(id);
    close();
  }

  // The confirm replaces its row, so closing it would drop focus to <body>: return it to the row's
  // delete button, or to the first item when the row is gone.
  const focusAfterConfirm = useRef<string | null>(null);
  useEffect(() => {
    const id = focusAfterConfirm.current;
    if (confirming !== null || id === null) return;
    focusAfterConfirm.current = null;
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>(`[data-delete="${id}"]`) ?? panel?.querySelector<HTMLElement>('[role="menuitem"]'))?.focus();
  }, [confirming]);
  function endConfirm(id: string) {
    focusAfterConfirm.current = id;
    setConfirming(null);
  }

  function deleted(id: string) {
    setThreads((ts) => (ts ?? []).filter((t) => t.id !== id));
    // The open conversation is gone; a stale view of it would only be refused on the next send.
    if (id === activeId) selectAndClose(`t-${Date.now().toString(36)}`);
    else endConfirm(id);
  }

  const list = threads ?? [];
  return (
    <div className="history-menu" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="ghost-btn"
        aria-label="Conversation history"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <ClockCounterClockwise size={16} weight="duotone" />
      </button>
      {open && (
        <div className="history-panel" role="menu" ref={panelRef}>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="history-row history-new"
            onClick={() => selectAndClose(`t-${Date.now().toString(36)}`)}
          >
            + New conversation
          </button>
          {error && <div className="history-empty panel-error" role="alert">{error}</div>}
          {threads !== null && !error && list.length === 0 && <div className="history-empty">No conversations yet</div>}
          {list.slice(0, MENU_ROWS).map((t) => (confirming === t.id
            ? <ConfirmDeleteThread key={t.id} thread={t} onDeleted={() => deleted(t.id)} onCancel={() => endConfirm(t.id)} />
            : (
              <div role="none" className="history-item" key={t.id}>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={`history-row${t.id === activeId ? ' active' : ''}`}
                  onClick={() => selectAndClose(t.id)}
                >
                  <span className="history-title">{t.title}</span>
                  {t.notebook && <span className="history-notebook">{t.notebook.title}</span>}
                  <span className="history-time">{relativeTime(t.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="ghost-btn history-delete"
                  data-delete={t.id}
                  aria-label={`Delete “${t.title}”`}
                  onClick={() => setConfirming(t.id)}
                >
                  <Trash size={14} aria-hidden="true" />
                </button>
              </div>
            )))}
          {list.length > MENU_ROWS && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="history-row history-more"
              onClick={() => { close(); panelBus.openPalette(); }}
            >
              search all {list.length} conversations
            </button>
          )}
        </div>
      )}
    </div>
  );
}
