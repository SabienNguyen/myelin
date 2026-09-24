// Notebooks: a subject's conversations and sources kept together, NotebookLM-style.
//
// Two screens outside the chat workspace — the home grid (#/notebooks) and one notebook
// (#/notebooks/<id>) — plus the topbar crumb that says which notebook the open conversation is
// filed under. Everything a card shows (topics, mastery, due) comes from notebookRoutes.ts, which
// derives it from the student ledger on every read; this file only renders it and sends the
// learner's edits back.
import { useEffect, useRef, useState } from 'react';
import { NotebookIcon as NotebookGlyph } from '@phosphor-icons/react/dist/csr/Notebook';
import {
  ApiError, createNotebook, deleteNotebook, fileThread, getNotebook, getNotebooks, getPageNotebooks, getThreadNotebook,
  renameNotebook, setNotebookSources,
  type NotebookDetail, type NotebookLevel, type NotebookRef, type NotebookSummary, type NotebooksPayload, type NotebookTopic,
} from '../lib/api.js';
import { notebookHash, serializeHash } from '../lib/urlState.js';
import { panelBus } from '../lib/panelBus.js';
import { relativeTime } from './HistoryMenu.js';
import { Collapsible } from './Collapsible.js';
import { setPendingAsk, type PendingAsk } from '../lib/pendingAsk.js';

const LEVELS: NotebookLevel[] = ['mastered', 'practicing', 'exposed', 'unseen'];
const LEVEL_LABEL: Record<NotebookLevel, string> = {
  mastered: 'mastered', practicing: 'practicing', exposed: 'exposed', unseen: 'not started',
};

const threadHref = (threadId: string, pageSlug: string | null = null) =>
  serializeHash({ threadId, tab: pageSlug ? 'page' : 'stage', pageSlug });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How many of a notebook's conversations show before "show all" — the recent ones are where the
 *  learner picks up; a long notebook's full history would push Sources and Topics off screen. */
const RECENT_THREADS = 6;

/** Opens a fresh conversation already filed under the notebook, so its first turn's bootstrap
 *  (session.ts) knows which notebook it is in. With `firstMessage`, the conversation opens by
 *  sending it (lib/pendingAsk.ts). */
async function startConversation(notebookId: string, first?: PendingAsk): Promise<void> {
  const threadId = `t-${Date.now().toString(36)}`;
  await fileThread(notebookId, threadId);
  if (first) setPendingAsk(threadId, first);
  location.hash = threadHref(threadId);
}

/** What to do with one topic, from where it stands: review it when due, learn it when not started,
 *  practise it otherwise. Pure. */
export function topicVerb(t: Pick<NotebookTopic, 'due' | 'level'>): 'review' | 'learn' | 'practice' {
  if (t.due) return 'review';
  return t.level === 'unseen' ? 'learn' : 'practice';
}

export function topicAsk(t: Pick<NotebookTopic, 'due' | 'level' | 'title'>): string {
  const verb = topicVerb(t);
  if (verb === 'review') return `Review ${t.title} with me. Check me before reteaching anything.`;
  if (verb === 'learn') return `Teach me ${t.title}.`;
  return `Give me practice on ${t.title}. Check what I can do before explaining.`;
}

export interface StudioAction { label: string; hint: string; ask: PendingAsk }

/**
 * NotebookLM's Studio, done by the tutor: each action opens a conversation in this notebook that
 * asks for one kind of study material, grounded in the notebook's own pages by name — so what comes
 * back is built from the learner's material, with the tutor's usual rules (cite pages, check before
 * crediting) rather than a one-shot generator's. Empty for a notebook that covers no page yet:
 * there is nothing of its own to build from. Pure.
 */
export function studioActions(detail: Pick<NotebookDetail, 'notebook' | 'topics'>): StudioAction[] {
  if (detail.topics.length === 0) return [];
  const title = detail.notebook.title;
  const pages = detail.topics.map((t) => t.title).join(', ');
  return [
    {
      label: 'Study guide', hint: 'key ideas, an example and a common mistake per page',
      ask: { text: `Write a study guide for ${title}. Cover its pages (${pages}): for each, the key idea, one worked example and one common mistake, naming the page each part comes from.` },
    },
    {
      label: 'Quiz me', hint: 'one quiz across the whole notebook',
      ask: { text: `Quiz me across ${title}. One question per page, mixed in order: ${pages}.`, command: 'quiz' },
    },
    {
      label: 'Glossary', hint: 'the terms these pages use, defined',
      ask: { text: `Make a glossary for ${title}. Take the terms its pages use (${pages}), each with a one-line definition and the page it comes from.` },
    },
    {
      label: 'How it connects', hint: 'which ideas build on which',
      ask: { text: `Explain how the ideas in ${title} connect. Which of these build on which, and why does the order matter: ${pages}?` },
    },
  ];
}

/** The "study now" message: what is due, by name, so the tutor starts where the ledger says. */
export function studyNowMessage(detail: Pick<NotebookDetail, 'notebook' | 'topics'>): string | null {
  const due = detail.topics.filter((t) => t.due).map((t) => t.title);
  if (due.length === 0) return null;
  return `Review what is due in ${detail.notebook.title}: ${due.join(', ')}. Check me on each before reteaching anything.`;
}

function MasteryBar({ mastery, topics }: { mastery: Record<NotebookLevel, number>; topics: number }) {
  if (topics === 0) return <div className="nb-meter nb-meter--empty" aria-hidden="true" />;
  const summary = LEVELS.filter((l) => mastery[l] > 0).map((l) => `${mastery[l]} ${LEVEL_LABEL[l]}`).join(', ');
  return (
    // role="img" with a text alternative: the segments ARE the information, and a screen reader
    // should hear the same counts the bar draws.
    <div className="nb-meter" role="img" aria-label={`Topics: ${summary}`}>
      {LEVELS.map((l) => mastery[l] > 0 && (
        <span key={l} className={`nb-meter-seg nb-level-${l}`} style={{ flexGrow: mastery[l] }} />
      ))}
    </div>
  );
}

function MasteryLegend() {
  return (
    <ul className="nb-legend" aria-hidden="true">
      {LEVELS.map((l) => (
        <li key={l}><span className={`nb-dot nb-level-${l}`} />{LEVEL_LABEL[l]}</li>
      ))}
    </ul>
  );
}

function NotebookCard({ nb }: { nb: NotebookSummary }) {
  return (
    <a className="nb-card" href={notebookHash(nb.id)}>
      <span className="nb-card-head">
        <span className="nb-card-title">{nb.title}</span>
        {nb.due > 0
          ? <span className="nb-pill nb-pill--due">{plural(nb.due, 'review')} due</span>
          : nb.topics > 0 && <span className="nb-pill">caught up</span>}
      </span>
      <span className="nb-card-meta">
        {plural(nb.sources, 'source')} · {plural(nb.chats, 'conversation')} · {plural(nb.topics, 'topic')}
      </span>
      <MasteryBar mastery={nb.mastery} topics={nb.topics} />
      <span className="nb-card-time">active {relativeTime(nb.lastActive)}</span>
    </a>
  );
}

function CreateNotebook() {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const nb = await createNotebook(title.trim());
      location.hash = notebookHash(nb.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }
  return (
    <form className="nb-create" onSubmit={submit}>
      <label htmlFor="nb-new-title">New notebook</label>
      <input
        id="nb-new-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="e.g. Calculus I"
        maxLength={80}
      />
      <button type="submit" className="primary" disabled={!title.trim() || busy}>Create</button>
      {error && <p className="panel-error" role="alert">{error}</p>}
    </form>
  );
}

/**
 * Library sources no notebook uses yet, each one click from a notebook of its own — the way
 * NotebookLM starts a notebook from what you give it. The notebook takes the source's title, which
 * the learner can rename; the source is attached in the same request, so there is never an empty
 * notebook left behind by a failure.
 */
function StartFromSource({ sources }: { sources: NonNullable<NotebooksPayload['looseSources']> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function start(book: string, title: string) {
    setBusy(book);
    setError(null);
    try {
      const nb = await createNotebook(title, [book]);
      location.hash = notebookHash(nb.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }
  return (
    <section className="nb-section" aria-labelledby="nb-loose-h">
      <h3 id="nb-loose-h" className="nb-subheading">Start from a source</h3>
      <ul className="nb-list">
        {sources.map((s) => (
          <li key={s.book} className="nb-row">
            <span className="nb-row-title">{s.title}</span>
            {s.authors.length > 0 && <span className="nb-row-time">{s.authors.join(', ')}</span>}
            <button
              type="button"
              className="ghost-btn nb-small nb-action"
              disabled={busy !== null}
              aria-label={`Start a notebook from ${s.title}`}
              onClick={() => start(s.book, s.title)}
            >
              {busy === s.book ? 'starting…' : 'start a notebook'}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="panel-error" role="alert">{error}</p>}
    </section>
  );
}

/** A conversation outside every notebook, with a way to file it under one. */
function UnfiledRow({ thread, notebooks, onFiled }: {
  thread: NotebooksPayload['unfiled'][number]; notebooks: NotebookSummary[]; onFiled: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const selectId = `nb-file-${thread.id}`;
  async function file(id: string) {
    if (!id) return;
    try {
      await fileThread(id, thread.id);
      onFiled();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <li className="nb-row">
      <a href={threadHref(thread.id)} className="nb-row-title">{thread.title}</a>
      <span className="nb-row-time">{relativeTime(thread.updatedAt)}</span>
      {notebooks.length > 0 && (
        <>
          <label htmlFor={selectId} className="visually-hidden">File “{thread.title}” under a notebook</label>
          <select id={selectId} value="" onChange={(e) => file(e.target.value)}>
            <option value="">file under…</option>
            {notebooks.map((nb) => <option key={nb.id} value={nb.id}>{nb.title}</option>)}
          </select>
        </>
      )}
      {error && <p className="panel-error" role="alert">{error}</p>}
    </li>
  );
}

export function NotebooksHome() {
  const [data, setData] = useState<NotebooksPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allUnfiled, setAllUnfiled] = useState(false);
  function load() {
    getNotebooks().then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }
  useEffect(load, []);

  return (
    <div className="nb-page">
      <div className="nb-page-head">
        <div>
          <h2 className="nb-heading">Notebooks</h2>
          <p className="nb-lede">Each notebook keeps one subject’s conversations and sources together.</p>
        </div>
        <CreateNotebook />
      </div>
      {error && <p className="panel-error" role="alert">{error}</p>}
      {!data && !error && <p className="empty" role="status">loading notebooks…</p>}
      {data && (
        <>
          {data.notebooks.length === 0
            ? <p className="empty">No notebooks yet. Name one above to start.</p>
            : (
              <>
                <ul className="nb-grid">
                  {data.notebooks.map((nb) => <li key={nb.id}><NotebookCard nb={nb} /></li>)}
                </ul>
                <MasteryLegend />
              </>
            )}
          {(data.looseSources?.length ?? 0) > 0 && <StartFromSource sources={data.looseSources!} />}
          {data.unfiled.length > 0 && (
            <section className="nb-section" aria-labelledby="nb-unfiled-h">
              <h3 id="nb-unfiled-h" className="nb-subheading">Conversations outside a notebook</h3>
              <ul className="nb-list" id="nb-unfiled-list">
                {(allUnfiled ? data.unfiled : data.unfiled.slice(0, RECENT_THREADS)).map((t) => (
                  <UnfiledRow key={t.id} thread={t} notebooks={data.notebooks} onFiled={load} />
                ))}
              </ul>
              {data.unfiled.length > RECENT_THREADS && (
                <button type="button" className="ghost-btn nb-small" aria-expanded={allUnfiled}
                  aria-controls="nb-unfiled-list" onClick={() => setAllUnfiled((v) => !v)}>
                  {allUnfiled ? 'show recent only' : `show all ${data.unfiled.length}`}
                </button>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function RenameForm({ nb, onDone }: { nb: NotebookSummary; onDone: (renamed: boolean) => void }) {
  const [title, setTitle] = useState(nb.title);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await renameNotebook(nb.id, title.trim());
      onDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <form className="nb-rename" onSubmit={submit}>
      <label htmlFor="nb-rename-title" className="visually-hidden">Notebook name</label>
      <input id="nb-rename-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} autoFocus />
      <button type="submit" className="primary" disabled={!title.trim()}>Save</button>
      <button type="button" onClick={() => onDone(false)}>Cancel</button>
      {error && <p className="panel-error" role="alert">{error}</p>}
    </form>
  );
}

function SourcePicker({ detail, onSaved, onCancel }: {
  detail: NotebookDetail; onSaved: () => void; onCancel: () => void;
}) {
  const [picked, setPicked] = useState(() => new Set(detail.sources.map((s) => s.book)));
  const [error, setError] = useState<string | null>(null);
  if (detail.library.length === 0) {
    return (
      <div className="nb-picker">
        <p className="empty">Nothing in the Library yet. Add material from the top bar, then choose it here.</p>
        <button type="button" onClick={onCancel}>Close</button>
      </div>
    );
  }
  function toggle(book: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(book)) next.delete(book); else next.add(book);
      return next;
    });
  }
  async function save() {
    try {
      await setNotebookSources(detail.notebook.id, [...picked]);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <fieldset className="nb-picker">
      <legend className="visually-hidden">Sources in this notebook</legend>
      {detail.library.map((s) => (
        <label key={s.book} className="nb-pick">
          <input type="checkbox" checked={picked.has(s.book)} onChange={() => toggle(s.book)} />
          <span>{s.title}{s.authors.length > 0 && <span className="nb-row-time"> · {s.authors.join(', ')}</span>}</span>
        </label>
      ))}
      <div className="nb-actions">
        <button type="button" className="primary" onClick={save}>Save sources</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
      {error && <p className="panel-error" role="alert">{error}</p>}
    </fieldset>
  );
}

export function NotebookView({ id }: { id: string }) {
  const [detail, setDetail] = useState<NotebookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [picking, setPicking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [allThreads, setAllThreads] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Guards a load from landing after this view has moved on. App also keys the view by notebook id,
  // so a jump from A to B mounts a fresh view; this covers a reload (after rename, sources)
  // racing an unmount.
  const alive = useRef(true);
  // Set on every mount, not only initialised: StrictMode mounts, cleans up and mounts again, and a
  // flag only ever cleared would drop every load after that first cleanup.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function load() {
    getNotebook(id).then((d) => { if (alive.current) { setDetail(d); setError(null); } })
      // getJson's 404 copy ("Nothing written for … yet") is about pages; a notebook that 404s was
      // deleted, or the link is stale.
      .catch((e) => {
        if (!alive.current) return;
        setError(e instanceof ApiError && e.status === 404
          ? 'This notebook no longer exists — it may have been deleted.'
          : e instanceof Error ? e.message : String(e));
      });
  }
  useEffect(() => { setDetail(null); load(); }, [id]);

  // One conversation per click: a fast double-click filed two threads and queued two first
  // messages, one of them never sent. Every button that starts a conversation checks this.
  const [starting, setStarting] = useState(false);
  async function newConversation(first?: PendingAsk) {
    if (starting) return;
    setStarting(true);
    setActionError(null);
    try {
      await startConversation(id, first);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }
  async function remove() {
    try {
      await deleteNotebook(id);
      location.hash = notebookHash();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setConfirmDelete(false);
    }
  }

  const back = <a className="nb-back" href={notebookHash()}>← Notebooks</a>;
  if (error) return <div className="nb-page">{back}<p className="panel-error" role="alert">{error}</p></div>;
  if (!detail) return <div className="nb-page">{back}<p className="empty" role="status">loading notebook…</p></div>;

  const nb = detail.notebook;
  // Topics open in the notebook's most recent conversation, where the Page tab can show them; a
  // notebook with no conversation yet lists them as plain text.
  const latest = detail.threads[0]?.id ?? null;
  const studyNow = studyNowMessage(detail);
  const studio = studioActions(detail);

  return (
    <div className="nb-page">
      {back}
      <div className="nb-page-head">
        {renaming
          ? <RenameForm nb={nb} onDone={(renamed) => { setRenaming(false); if (renamed) load(); }} />
          : (
            <div className="nb-title-row">
              <h2 className="nb-heading">{nb.title}</h2>
              <button type="button" className="ghost-btn nb-small" onClick={() => setRenaming(true)}>rename</button>
            </div>
          )}
        <div className="nb-actions">
          {/* Anki's "Study now": one click from the deck to the reviews it is waiting on. Offered
              only when something is due, so it never starts a session with nothing to do. */}
          {studyNow && (
            <button type="button" className="primary" disabled={starting} onClick={() => newConversation({ text: studyNow })}>
              Review {plural(detail.topics.filter((t) => t.due).length, 'due topic')}
            </button>
          )}
          <button type="button" className={studyNow ? '' : 'primary'} disabled={starting} onClick={() => newConversation()}>
            New conversation
          </button>
        </div>
      </div>
      <p className="nb-card-meta nb-stats">
        {nb.due > 0 && <span className="nb-pill nb-pill--due">{plural(nb.due, 'review')} due</span>}
        <span>{plural(nb.topics, 'topic')} · {plural(nb.sources, 'source')} · {plural(nb.chats, 'conversation')}</span>
      </p>
      <MasteryBar mastery={nb.mastery} topics={nb.topics} />
      {nb.topics > 0 && <MasteryLegend />}
      {actionError && <p className="panel-error" role="alert">{actionError}</p>}

      {studio.length > 0 && (
        <section className="nb-studio" aria-labelledby="nb-studio-h">
          <h3 id="nb-studio-h" className="nb-subheading">Studio</h3>
          <ul>
            {studio.map((a) => (
              <li key={a.label}>
                <button type="button" disabled={starting} onClick={() => newConversation(a.ask)}>
                  <span className="nb-studio-label">{a.label}</span>
                  <span className="nb-studio-hint">{a.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="nb-columns">
        <section className="nb-section" aria-labelledby="nb-conv-h">
          <div className="nb-section-head"><h3 id="nb-conv-h" className="nb-subheading">Conversations</h3></div>
          {detail.threads.length === 0
            ? <p className="empty">No conversations yet. Start one and it stays in this notebook.</p>
            : (
              <ul className="nb-list" id="nb-conv-list">
                {(allThreads ? detail.threads : detail.threads.slice(0, RECENT_THREADS)).map((t) => (
                  <li key={t.id} className="nb-row">
                    <a href={threadHref(t.id)} className="nb-row-title">{t.title}</a>
                    <span className="nb-row-time">{relativeTime(t.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          {detail.threads.length > RECENT_THREADS && (
            <button type="button" className="ghost-btn nb-small" aria-expanded={allThreads}
              aria-controls="nb-conv-list" onClick={() => setAllThreads((v) => !v)}>
              {allThreads ? 'show recent only' : `show all ${detail.threads.length}`}
            </button>
          )}
        </section>

        <section className="nb-section" aria-labelledby="nb-src-h">
          <div className="nb-section-head">
            <h3 id="nb-src-h" className="nb-subheading">Sources</h3>
            {!picking && <button type="button" className="ghost-btn nb-small" onClick={() => setPicking(true)}>choose sources</button>}
          </div>
          {picking
            ? <SourcePicker detail={detail} onSaved={() => { setPicking(false); load(); }} onCancel={() => setPicking(false)} />
            : detail.sources.length === 0
              ? <p className="empty">No sources yet. Choose material from your Library to ground this notebook.</p>
              : (
                <ul className="nb-list">
                  {detail.sources.map((s) => (
                    <li key={s.book} className="nb-row">
                      <span className="nb-row-title">{s.title}</span>
                      {s.authors.length > 0 && <span className="nb-row-time">{s.authors.join(', ')}</span>}
                    </li>
                  ))}
                </ul>
              )}
        </section>

        <section className="nb-section" aria-labelledby="nb-topics-h">
          <div className="nb-section-head"><h3 id="nb-topics-h" className="nb-subheading">Topics</h3></div>
          {detail.topics.length === 0
            ? <p className="empty">Topics appear here as its conversations and sources cover pages.</p>
            : (
              <ul className="nb-list">
                {detail.topics.map((t) => (
                  <li key={t.slug} className="nb-row">
                    <span className={`nb-dot nb-level-${t.level}`} aria-hidden="true" />
                    {latest
                      ? <a href={threadHref(latest, t.slug)} className="nb-row-title">{t.title}</a>
                      : <span className="nb-row-title">{t.title}</span>}
                    {t.due && <span className="nb-pill nb-pill--due">due</span>}
                    {/* The outline's rows are also ways in, as Khan Academy puts "practice" beside
                        each skill: what to do with a topic follows from where it stands. */}
                    <button
                      type="button"
                      className="ghost-btn nb-small nb-action"
                      disabled={starting}
                      aria-label={`${topicVerb(t)} ${t.title}`}
                      onClick={() => newConversation({ text: topicAsk(t) })}
                    >
                      {topicVerb(t)}
                    </button>
                    <span className="nb-row-time">
                      {LEVEL_LABEL[t.level]}
                      {/* Anki shows when a card comes back; this shows when a level would start
                          to slip — the reason to come back before it does. */}
                      {!t.due && typeof t.daysLeft === 'number' && ` · holds ${t.daysLeft}d`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
        </section>
      </div>

      <div className="nb-danger">
        {confirmDelete
          ? (
            <div role="alertdialog" aria-labelledby="nb-del-q" className="nb-confirm">
              <p id="nb-del-q">Delete “{nb.title}”? Its conversations and sources are kept; only the notebook goes.</p>
              <div className="nb-actions">
                <button type="button" className="nb-delete" onClick={remove}>Delete notebook</button>
                <button type="button" onClick={() => setConfirmDelete(false)} autoFocus>Cancel</button>
              </div>
            </div>
          )
          : <button type="button" className="ghost-btn nb-small" onClick={() => setConfirmDelete(true)}>delete notebook</button>}
      </div>
    </div>
  );
}

/** Topbar: a way to the notebooks from any conversation, and which one this conversation is in. */
export function NotebookCrumb({ threadId }: { threadId: string }) {
  const [nb, setNb] = useState<NotebookRef | null>(null);
  const version = useFiledVersion(threadId);
  useEffect(() => {
    let cancelled = false;
    setNb(null);
    getThreadNotebook(threadId)
      .then((r) => { if (!cancelled) setNb(r); })
      // The crumb is navigation sugar: without it the Notebooks link still works, and the
      // conversation itself is unaffected. Logged so a broken route is still visible.
      .catch((e) => console.error('[notebooks] could not look up this conversation’s notebook:', e));
    return () => { cancelled = true; };
  }, [threadId, version]);
  return (
    <nav className="notebook-crumb" aria-label="Notebook">
      <a href={notebookHash()} className="notebook-crumb-link">
        <NotebookGlyph size={16} weight="duotone" aria-hidden="true" /><span className="notebook-crumb-label">Notebooks</span>
      </a>
      {nb && (
        <>
          <span aria-hidden="true" className="notebook-crumb-sep">/</span>
          <a href={notebookHash(nb.id)} className="notebook-crumb-link">{nb.title}</a>
        </>
      )}
    </nav>
  );
}

export interface Starter { text: string; kind: 'review' | 'quiz' | 'new' }

/**
 * Up to four ways into a notebook's material for its empty conversation, the way NotebookLM offers
 * suggested questions from a notebook's sources. Ordered by what the learner most needs: what is
 * due, then what is half-learned (a quiz proves it), then what has not been started. With no
 * topics yet, the sources themselves are the way in. Pure, so the order is testable.
 */
export function notebookStarters(detail: Pick<NotebookDetail, 'topics' | 'sources'>, max = 4): Starter[] {
  const out: Starter[] = [];
  const add = (s: Starter) => { if (out.length < max) out.push(s); };
  for (const t of detail.topics) if (t.due) add({ text: `Review ${t.title} with me`, kind: 'review' });
  for (const t of detail.topics) {
    if (!t.due && (t.level === 'exposed' || t.level === 'practicing')) add({ text: `Quiz me on ${t.title}`, kind: 'quiz' });
  }
  for (const t of detail.topics) if (!t.due && t.level === 'unseen') add({ text: `Teach me ${t.title}`, kind: 'new' });
  if (detail.topics.length === 0) {
    for (const s of detail.sources) add({ text: `What are the main ideas in ${s.title}?`, kind: 'new' });
  }
  return out;
}

/** Counts panelBus notebookFiled events for this conversation, so a lookup keyed on it runs again
 *  when the conversation is filed from inside the workspace. */
function useFiledVersion(threadId: string | undefined): number {
  const [version, setVersion] = useState(0);
  useEffect(() => panelBus.subscribe((e) => {
    if (e.type === 'notebookFiled' && e.threadId === threadId) setVersion((v) => v + 1);
  }), [threadId]);
  return version;
}

/** The notebook an open conversation is filed under, with its detail: `undefined` while looking,
 *  `null` for a conversation outside every notebook (or when the lookup failed — logged, and the
 *  empty state falls back to the general one rather than blocking the chat). */
export function useConversationNotebook(threadId: string | undefined): NotebookDetail | null | undefined {
  const [detail, setDetail] = useState<NotebookDetail | null | undefined>(undefined);
  const version = useFiledVersion(threadId);
  useEffect(() => {
    if (!threadId) { setDetail(null); return; }
    let cancelled = false;
    setDetail(undefined);
    getThreadNotebook(threadId)
      .then((ref) => (ref && typeof ref.id === 'string' ? getNotebook(ref.id) : null))
      // A reply without the notebook's summary is no notebook to open on (an older server, a
      // proxy page) — the general empty state, not a crash in NotebookIntro.
      .then((d) => { if (!cancelled) setDetail(d && d.notebook ? d : null); })
      .catch((e) => {
        console.error('[notebooks] could not load this conversation’s notebook:', e);
        if (!cancelled) setDetail(null);
      });
    return () => { cancelled = true; };
  }, [threadId, version]);
  return detail;
}

/**
 * On the general empty chat, the learner's notebooks as a way in: "work in Calculus I" files THIS
 * conversation under it, and the empty state turns into that notebook's own opening. Up to four,
 * most recently active first (the order /api/notebooks already returns). Nothing when there are no
 * notebooks — the general welcome stands on its own.
 */
export function NotebookPicker({ threadId }: { threadId: string }) {
  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getNotebooks()
      .then((d) => { if (!cancelled) setNotebooks(Array.isArray(d.notebooks) ? d.notebooks.slice(0, 4) : []); })
      // The picker is an extra way in; without it the chat works as ever. Logged, not shown.
      .catch((e) => console.error('[notebooks] could not list notebooks for the empty chat:', e));
    return () => { cancelled = true; };
  }, []);
  async function file(id: string) {
    setError(null);
    try {
      await fileThread(id, threadId);
      panelBus.notebookFiled(threadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  if (notebooks.length === 0) return null;
  return (
    <div className="nb-picker-row">
      <span className="nb-picker-lede">Or work in a notebook:</span>
      <ul aria-label="Your notebooks">
        {notebooks.map((nb) => (
          <li key={nb.id}>
            <button type="button" className="chip-btn" onClick={() => file(nb.id)}>
              <NotebookGlyph size={13} weight="duotone" aria-hidden="true" />
              {nb.title}
              {nb.due > 0 && <span className="nb-picker-due"> · {nb.due} due</span>}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="panel-error" role="alert">{error}</p>}
    </div>
  );
}

const STARTER_LABEL: Record<Starter['kind'], string> = { review: 'due', quiz: 'quiz', new: 'new' };

/** The notebook's own opening for an empty conversation: whose material this is, how far along
 *  it is, and a few ways in. `onAsk` sends a starter as the learner's first message. */
export function NotebookIntro({ detail, onAsk }: { detail: NotebookDetail; onAsk: (text: string) => void }) {
  const nb = detail.notebook;
  const starters = notebookStarters(detail);
  return (
    <div className="nb-intro">
      <a className="nb-intro-name" href={notebookHash(nb.id)}>
        <NotebookGlyph size={16} weight="duotone" aria-hidden="true" />{nb.title}
      </a>
      <h2>What do you want to explore?</h2>
      <p>
        Answers draw on this notebook first: {plural(nb.sources, 'source')} and {plural(nb.topics, 'page')} so
        far{nb.due > 0 ? `, ${plural(nb.due, 'review')} due` : ''}.
      </p>
      {nb.topics > 0 && <MasteryBar mastery={nb.mastery} topics={nb.topics} />}
      {starters.length > 0 && (
        <ul className="nb-starters" aria-label="Ways to start">
          {starters.map((s) => (
            <li key={s.text}>
              <button type="button" onClick={() => onAsk(s.text)}>
                <span className={`nb-starter-kind nb-starter-kind--${s.kind}`}>{STARTER_LABEL[s.kind]}</span>
                {s.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The Page tab's "in <notebook>" links: which notebooks this page belongs to, one click back to
 *  each — the page's side of the notebook's topic list. Nothing for a page no notebook covers. */
export function PageNotebooks({ slug }: { slug: string }) {
  const [refs, setRefs] = useState<NotebookRef[]>([]);
  useEffect(() => {
    let cancelled = false;
    setRefs([]);
    getPageNotebooks(slug)
      .then((r) => { if (!cancelled) setRefs(Array.isArray(r) ? r : []); })
      // Navigation sugar only: the page itself is unaffected. Logged so a broken route shows.
      .catch((e) => console.error('[notebooks] could not look up this page’s notebooks:', e));
    return () => { cancelled = true; };
  }, [slug]);
  return (
    <>
      {refs.map((nb) => (
        <a key={nb.id} className="page-chip page-notebook" href={notebookHash(nb.id)}>
          <NotebookGlyph size={12} weight="duotone" aria-hidden="true" />
          <span className="visually-hidden">in notebook</span>{' '}{nb.title}
        </a>
      ))}
    </>
  );
}

/** The Library's per-subject progress: each notebook's mastery bar and what is due, one click from
 *  the notebook itself. The Library's own progress card is the whole vault; this is the same read
 *  split by the subjects the learner named. Fetches only while the Library is on screen. */
export function NotebooksSection({ visible = true }: { visible?: boolean }) {
  const [data, setData] = useState<NotebookSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    getNotebooks()
      .then((d) => { if (!cancelled) { setData(Array.isArray(d.notebooks) ? d.notebooks : []); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [visible]);
  if (error) return <p className="panel-error" role="status">{error}</p>;
  if (!data) return null;
  return (
    <Collapsible id="notebooks" className="nb-library" title="Notebooks">
      {data.length === 0
        ? (
          <p className="empty">
            No notebooks yet. <a href={notebookHash()}>Group a subject’s conversations and sources</a> to see its progress here.
          </p>
        )
        : (
          <ul className="nb-library-list">
            {data.map((nb) => (
              <li key={nb.id}>
                <div className="nb-library-head">
                  <a href={notebookHash(nb.id)} className="nb-row-title">{nb.title}</a>
                  {nb.due > 0 && <span className="nb-pill nb-pill--due">{nb.due} due</span>}
                  <span className="nb-row-time">{plural(nb.topics, 'topic')}</span>
                </div>
                <MasteryBar mastery={nb.mastery} topics={nb.topics} />
              </li>
            ))}
          </ul>
        )}
    </Collapsible>
  );
}
