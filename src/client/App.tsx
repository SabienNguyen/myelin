import { useEffect, useRef, useState } from 'react';
import { BookOpenTextIcon as BookOpenText } from '@phosphor-icons/react';
import { getGraph } from './lib/api.js';
import { Runtime } from './runtime.js';
import { Thread } from './components/Thread.js';
import { SidePanel } from './components/SidePanel.js';
import { TopbarStatus } from './components/TopbarStatus.js';
import { HistoryMenu } from './components/HistoryMenu.js';
import { FocusRail } from './components/FocusRail.js';
import { FirstRun } from './components/FirstRun.js';
import { AddMaterial } from './components/AddMaterial.js';
import { NotebookCrumb, NotebookView, NotebooksHome } from './components/Notebooks.js';
import { CommandPalette } from './components/CommandPalette.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { panelBus } from './lib/panelBus.js';
import { parseHash, parseNotebookRoute, serializeHash } from './lib/urlState.js';

export function App() {
  // '' means "let the harness decide", which is chat (deriveMode.ts) — the mode selector is gone.
  // Three of the four modes were only a framing sentence, and the three mechanisms that had grown
  // up to route around the selector (coldStartMode, writeIntent, the mode slash commands) were the
  // system saying so. A study-family command (/study, /review, /quiz, /freeform) makes its mode
  // sticky until the learner ends it from the composer chip or sends /chat; see the design at
  // docs/superpowers/specs/2026-07-31-one-mode-design.html and plans/2026-09-22-chat-first.md.
  // A study session belongs to the conversation it was started in, so the sticky mode is kept per
  // thread: a look at another conversation opens that one in chat and leaves this one studying.
  // A single value reset on every switch ended the session with no sign it had ended.
  const [modes, setModes] = useState<Record<string, string>>({});
  const [threadId, setThreadId] = useState(() => parseHash(location.hash).threadId);
  const mode = modes[threadId] ?? '';
  const setMode = (next: string) => setModes((prev) => ({ ...prev, [threadId]: next }));
  // The notebooks screens (#/notebooks, #/notebooks/<id>) replace the chat workspace; null means
  // a conversation is open. The thread id above is kept while they show, so Back returns to it.
  const [notebookRoute, setNotebookRoute] = useState(() => parseNotebookRoute(location.hash));

  // A hash route swaps the whole main region with no page load, so nothing tells a screen reader
  // the screen changed. Empty until the first change: the initial screen came with a page load.
  const routeKey = notebookRoute ? `nb:${notebookRoute.notebookId ?? ''}` : `t:${threadId}`;
  const [announcement, setAnnouncement] = useState('');
  const announcedRoute = useRef(routeKey);
  useEffect(() => {
    if (announcedRoute.current === routeKey) return;
    announcedRoute.current = routeKey;
    setAnnouncement(notebookRoute ? (notebookRoute.notebookId ? 'notebook opened' : 'notebooks opened') : 'conversation opened');
  }, [routeKey, notebookRoute]);

  // Whether the vault has anything real to teach from. This used to pick a MODE (coldStartMode:
  // an empty vault opened in freeform, because teaching modes could not write and a newcomer's
  // first lesson "researched well, taught well, and then evaporated"). It is now just an input to
  // the harness's own decision — a fact about the vault rather than a control setting. Stubs do
  // not count: both boot-seeded pattern stubs and Engram's auto-created prereq stubs are
  // placeholders, exactly what vaultGap refuses to ground in. Graph unreachable → assume it is
  // fine; the setup gate and TopbarStatus already surface that failure.
  const [emptyVault, setEmptyVault] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getGraph()
      .then((g) => {
        if (!cancelled) setEmptyVault(!(g.nodes ?? []).some((n: { status?: string }) => n.status !== 'stub'));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // P1 (docs/superpowers/plans/2026-07-20-gap-integration.md): IDE focus mode. A code_exercise
  // block (CodeExercise.tsx) emits panelBus `focusMode` on mount-with-no-result / unmount; App
  // owns the resulting `.app.focus-mode` class (documented choice — least invasive against the
  // existing SidePanel/App structure: a CSS grid change, not a new layout component tree). `peek`
  // is local UI state (not part of the bus event) letting the learner glance at chat without
  // exiting focus mode; it always resets when focus mode itself turns off, so the next exercise
  // starts collapsed again.
  const [focusMode, setFocusMode] = useState(false);
  const [peek, setPeek] = useState(false);
  // Idempotent on purpose (post-review hardening): a functional updater that bails to the SAME
  // state reference when the value hasn't changed, rather than trusting React's primitive-value
  // bailout alone — defense-in-depth against a StagePortal/CodeExercise subtree that legitimately
  // remounts (e.g. a fast reload or thread switch racing an unmount) re-emitting the value it
  // already holds.
  useEffect(() => panelBus.subscribe((e) => {
    if (e.type === 'focusMode') setFocusMode((prev) => (prev === e.on ? prev : e.on));
  }), []);
  useEffect(() => { if (!focusMode) setPeek(false); }, [focusMode]);

  // Deep-linking (T27): the URL hash encodes `#/t/<threadId>[/<tab>|/page/<slug>]`. App owns
  // only the threadId slice — SidePanel owns tab/page and re-parses the hash to preserve this
  // piece when it writes its own. Thread switches push a new history entry (unlike SidePanel's
  // tab flips, which replace) so Back returns to the prior conversation.
  function selectThread(id: string) {
    setThreadId(id);
    // pushState below never fires hashchange/popstate, so a pick made from the notebooks screen's
    // history menu must leave that route by hand — otherwise the URL moves to the conversation
    // but the notebooks screen stays on screen underneath it.
    setNotebookRoute(null);
    const current = parseHash(location.hash);
    // Stage is named outright: serializeHash leaves it implicit, and the remounted SidePanel's
    // map-as-home reads an implicit tab as "nothing chosen" and moved a learner on Stage to Graph.
    const serialized = serializeHash({ ...current, threadId: id });
    const nextHash = current.tab === 'stage' ? `${serialized}/stage` : serialized;
    if (nextHash !== location.hash) history.pushState(null, '', nextHash);
  }

  useEffect(() => {
    const onHashChange = () => {
      const route = parseNotebookRoute(location.hash);
      setNotebookRoute(route);
      if (route) return;
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

  const appClass = ['app', focusMode && 'focus-mode', focusMode && peek && 'peek'].filter(Boolean).join(' ');

  // The wordmark returns to the Stage of the conversation App still holds under the notebooks
  // screens. Stage is named outright for the same reason selectThread names it.
  const brand = (
    <h1>
      <a
        href={`${serializeHash({ threadId, tab: 'stage', pageSlug: null })}/stage`}
        aria-label="Myelin — back to your conversation"
      >
        <BookOpenText size={20} weight="duotone" aria-hidden="true" /> <span className="brand-word">Myelin</span>
      </a>
    </h1>
  );

  // The topbar sits OUTSIDE <Runtime key={threadId}>: inside it, every thread switch remounted
  // the header (focus dropped to <body> mid-HistoryMenu) and a failed thread load left only an
  // error line with no history menu to leave by.
  return (
    <ErrorBoundary
      label="the app"
      // App's own route state lives above the boundary, so following the link re-renders it with
      // a new resetKey and the broken screen is dropped.
      resetKey={routeKey}
      fallback={(
        <main className="app-crash" role="alert">
          <p>something on this screen failed — reload, or <a href="#/notebooks">go to your notebooks</a></p>
        </main>
      )}
    >
      {/* Setup gate first: with no API key there is no tutor, so a Runtime that cannot answer must
          not mount and invite a question. Renders `children` untouched once the key is in place. */}
      <FirstRun>
        <div className={notebookRoute ? 'app' : appClass}>
          <p className="visually-hidden" role="status">{announcement}</p>
          <header className="topbar">
            {brand}
            {!notebookRoute && <NotebookCrumb threadId={threadId} />}
            <CommandPalette threadId={threadId} />
            <HistoryMenu activeId={threadId} onSelect={selectThread} />
            <TopbarStatus />
            {/* THE add entry point — one control for every kind of material (file, git URL, local
                folder). Not one button per artifact; AddMaterial routes by what it was given. */}
            <AddMaterial threadId={threadId} />
          </header>
          {notebookRoute ? (
            <main className="notebooks-main">
              {notebookRoute.notebookId
                // Keyed: notebook A's state (a load in flight, an open delete confirmation) must
                // never carry over to notebook B.
                ? <NotebookView key={notebookRoute.notebookId} id={notebookRoute.notebookId} />
                : <NotebooksHome />}
            </main>
          ) : (
            // onSetMode: a /study-family command makes its mode sticky here (and /chat clears it)
            // — the server only overrides the one turn the command rides; persistence is this
            // state's job.
            <Runtime key={threadId} mode={mode} emptyVault={emptyVault} threadId={threadId} onSetMode={setMode}>
              <main className="workspace">
                <div className="thread-column">
                  <FocusRail peek={peek} onTogglePeek={() => setPeek((p) => !p)} />
                  <Thread mode={mode} onModeChange={setMode} threadId={threadId} />
                </div>
                <SidePanel />
              </main>
            </Runtime>
          )}
        </div>
      </FirstRun>
    </ErrorBoundary>
  );
}
