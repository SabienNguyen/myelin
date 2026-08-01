import { useEffect, useState } from 'react';
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
import { panelBus } from './lib/panelBus.js';
import { parseHash, serializeHash } from './lib/urlState.js';

export function App() {
  // '' means "let the harness decide" — the mode selector is gone. Three of the four modes were
  // only a framing sentence, and the three mechanisms that had grown up to route around the
  // selector (coldStartMode, writeIntent, the mode slash commands) were the system saying so.
  // A mode slash command still sets this for its one turn; see deriveMode.ts and the design at
  // docs/superpowers/specs/2026-07-31-one-mode-design.html.
  const [mode, setMode] = useState('');
  const [threadId, setThreadId] = useState(() => parseHash(location.hash).threadId);

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

  const appClass = ['app', focusMode && 'focus-mode', focusMode && peek && 'peek'].filter(Boolean).join(' ');

  return (
    // Setup gate first: with no API key there is no tutor, so a Runtime that cannot answer must not
    // mount and invite a question. Renders `children` untouched once the key is in place.
    <FirstRun>
    {/* onSetMode: a /learn-family slash command must land on this selector too — the server only
        overrides the one turn the command rides; persistence is the selector's job. */}
    <Runtime key={threadId} mode={mode} emptyVault={emptyVault} threadId={threadId} onSetMode={setMode}>
      <div className={appClass}>
        <header className="topbar">
          <h1><BookOpenText size={20} weight="duotone" /> Myelin</h1>
          <HistoryMenu activeId={threadId} onSelect={selectThread} />
          <TopbarStatus />
          {/* THE add entry point — one control for every kind of material (file, git URL, local
              folder). Not one button per artifact; AddMaterial routes by what it was given. */}
          <AddMaterial />
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
    </FirstRun>
  );
}
