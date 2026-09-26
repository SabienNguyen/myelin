// @vitest-environment jsdom
//
// Collapse/rail behavior (docs/superpowers/plans — side panel resize+collapse): the rail must never
// unmount tab bodies (#stage-root is StagePortal's only portal target), must reopen itself on any
// deliberate panelBus/hash navigation but NOT on the map-as-home default, and the Ctrl+\ shortcut
// and focus-mode suppression only exist at the App level (App owns the collapsed/width state), so
// this file mounts SidePanel standalone for the rail mechanics and the real App for the rest —
// same TestRuntime stand-in as notebooksNav.test.tsx/app-focus-mode.test.tsx, real enough that
// GraphPanel's unconditional useThreadRuntime() call (it is always mounted, only ever CSS-hidden)
// resolves through a real provider instead of needing a second, conflicting mock.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { AssistantRuntimeProvider, Tools, useAui, useLocalRuntime } from '@assistant-ui/react';
import { ChatStore, ChatStoreContext } from '../../src/client/chatCore/index.js';
import { toolkit } from '../../src/client/toolkit.js';
import { panelBus } from '../../src/client/lib/panelBus.js';
import { SidePanel } from '../../src/client/components/SidePanel.js';
import type { UIMessage } from '../../src/shared/uiMessages.js';

const COLLAPSED_KEY = 'myelin.sidePanel.collapsed';

// One scripted turn, its content swappable per test: most tests never send a message at all (App
// mounts and sits idle), the focus-mode test below needs the exact code_exercise mount-with-no-
// result payload app-focus-mode.test.tsx reproduced the P1 remount bug against. autoKickMessage
// gates whether TestRuntime sends it at all — most tests here want an idle thread.
let scriptedContent: unknown[] = [{ type: 'text' as const, text: '' }];
let autoKickMessage = false;
// The Stage-empty quiz shortcut only renders once the conversation already has assistant text —
// most tests here want a brand-new thread with none.
let initialChatMessages: UIMessage[] = [];

function TestRuntime({ children }: PropsWithChildren<Record<string, unknown>>) {
  const runtime = useLocalRuntime({ async run() { return { content: scriptedContent as any }; } });
  const aui = useAui({ tools: Tools({ toolkit }) });
  const kicked = useRef(false);
  useEffect(() => {
    if (!autoKickMessage || kicked.current) return;
    kicked.current = true;
    void runtime.thread.append({
      role: 'user',
      content: [{ type: 'text', text: 'Practice stream-consumer with a code exercise' }],
    });
  }, [runtime]);
  const [store] = useState(() => new ChatStore({
    threadId: 'test', initialMessages: initialChatMessages,
    requestContext: () => ({ mode: 'learn', writeUp: false }),
  }));
  return (
    <ChatStoreContext.Provider value={store}>
      <AssistantRuntimeProvider runtime={runtime} aui={aui}>{children}</AssistantRuntimeProvider>
    </ChatStoreContext.Provider>
  );
}
vi.mock('../../src/client/runtime.js', () => ({ Runtime: TestRuntime }));
const { App } = await import('../../src/client/App.js');

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const fullBodyRung = {
  id: 'stream-consumer--full_body--0',
  template: 'full_body',
  artifactId: 'stream-consumer',
  visible_pre: 'export async function consumeStream(response, onToken) {\n',
  visible_post: '\n}',
  reference_answer: '',
  prose: {},
};

/** /api/graph answers with `nodes` (a due count via /api/due); everything else resolves quietly —
 *  same shape as sidePanelMapHome.test.tsx's stub. */
function stubFetch(opts: { nodes?: unknown[]; due?: number } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.startsWith('/api/graph')) return { ok: true, json: async () => ({ nodes: opts.nodes ?? [] }) } as any;
    if (u.startsWith('/api/due')) return { ok: true, json: async () => ({ total: opts.due ?? 0 }) } as any;
    // LibraryPanel's ProgressCard renders whenever a test lands on the library tab and reads this
    // shape unguarded — same fixture as sidePanelMapHome.test.tsx.
    if (u.startsWith('/api/progress')) {
      return {
        ok: true,
        json: async () => ({
          byLevel: { mastered: 0, practicing: 0, exposed: 0 }, earnedThisWeek: 0, slipping: 0,
          today: { applied: 0, explained: 0, rubric: 0, struggled: 0, repaired: 0 },
          nextSlip: null, calibration: null,
        }),
      } as any;
    }
    if (u.startsWith('/api/page/')) {
      return {
        ok: true,
        json: async () => ({
          page: { slug: u.split('/').pop(), meta: {}, warnings: [], body: '' },
          edges: {}, neighbors: {}, standing: null,
        }),
      } as any;
    }
    // startsWith, not ===: getLadder sends the pattern as a query (see app-focus-mode.test.tsx's
    // stubFetch) — an exact match here never fires and the focus-mode test's exercise never loads.
    if (u.startsWith('/api/gap/ladder')) {
      return {
        ok: true,
        json: async () => ({
          ladder: { pattern: 'stream-consumer', targetArtifactId: 'stream-consumer', siblingArtifactId: null, rungs: [] },
          rungs: [fullBodyRung],
        }),
      } as any;
    }
    return { ok: true, json: async () => ({}) } as any;
  }));
}

function ControlledSidePanel({ initialCollapsed = false }: { initialCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  return <SidePanel collapsed={collapsed} onCollapsedChange={setCollapsed} />;
}

const railExpandBtn = () => screen.queryByRole('button', { name: 'Expand side panel' });
const collapseBtn = () => screen.queryByRole('button', { name: 'Collapse side panel' });

beforeEach(() => {
  localStorage.clear();
  scriptedContent = [{ type: 'text' as const, text: '' }];
  autoKickMessage = false;
  initialChatMessages = [];
  location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  location.hash = '';
});

describe('SidePanel collapse — the rail', () => {
  it('renders a rail while collapsed: tabs keep role=tab and their names, #stage-root stays in the DOM, bodies are hidden', async () => {
    stubFetch({ due: 3 });
    location.hash = '#/t/t-abc';
    render(<TestRuntime><ControlledSidePanel initialCollapsed /></TestRuntime>);
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());

    for (const name of ['stage', 'graph', 'page', 'library']) {
      const tab = screen.getByRole('tab', { name: new RegExp(`^${name}`, 'i') });
      expect(tab).toBeTruthy();
    }
    const libraryTab = screen.getByRole('tab', { name: /^library/i });
    expect(within(libraryTab).getByText('3')).toBeTruthy();

    const stageRoot = document.getElementById('stage-root');
    expect(stageRoot).not.toBeNull();
    expect(stageRoot?.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('panel-graph')?.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('panel-page')?.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('panel-library')?.hasAttribute('hidden')).toBe(true);

    // Not the normal strip at the same time — collapsed renders the rail INSTEAD of it.
    expect(collapseBtn()).toBeNull();
  });

  it('clicking a rail tab expands the panel and selects that tab', async () => {
    stubFetch();
    location.hash = '#/t/t-abc';
    render(<TestRuntime><ControlledSidePanel initialCollapsed /></TestRuntime>);
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());

    fireEvent.click(screen.getByRole('tab', { name: /^page/i }));

    await waitFor(() => expect(collapseBtn()).not.toBeNull());
    expect(railExpandBtn()).toBeNull();
    expect(screen.getByRole('tab', { name: 'page' }).getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('panel-page')?.hasAttribute('hidden')).toBe(false);
  });

  it('the expand button at the top of the rail also reopens the panel', async () => {
    stubFetch();
    location.hash = '#/t/t-abc';
    render(<TestRuntime><ControlledSidePanel initialCollapsed /></TestRuntime>);
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());
    fireEvent.click(railExpandBtn()!);
    await waitFor(() => expect(collapseBtn()).not.toBeNull());
  });

  it('the collapse button reports aria-expanded and collapses the panel on click', async () => {
    stubFetch();
    location.hash = '#/t/t-abc';
    render(<TestRuntime><ControlledSidePanel /></TestRuntime>);
    await waitFor(() => expect(collapseBtn()).not.toBeNull());
    expect(collapseBtn()?.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(collapseBtn()!);

    await waitFor(() => expect(railExpandBtn()).not.toBeNull());
    expect(railExpandBtn()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('a panelBus setTab while collapsed expands the panel onto that tab (StagePortal\'s mount signal)', async () => {
    stubFetch();
    location.hash = '#/t/t-abc';
    render(<TestRuntime><ControlledSidePanel initialCollapsed /></TestRuntime>);
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());

    act(() => { panelBus.setTab('library'); });

    await waitFor(() => expect(collapseBtn()).not.toBeNull());
    expect(screen.getByRole('tab', { name: /^library/i }).getAttribute('aria-selected')).toBe('true');
  });

  it('a panelBus openPage while collapsed expands the panel onto the page tab', async () => {
    stubFetch();
    location.hash = '#/t/t-abc';
    render(<TestRuntime><ControlledSidePanel initialCollapsed /></TestRuntime>);
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());

    act(() => { panelBus.openPage('derivatives'); });

    await waitFor(() => expect(collapseBtn()).not.toBeNull());
    expect(screen.getByRole('tab', { name: 'page' }).getAttribute('aria-selected')).toBe('true');
  });

  it('a hashchange that only names a tab keeps a collapsed panel collapsed, but still selects the tab', async () => {
    stubFetch();
    location.hash = '#/t/t-abc';
    render(<TestRuntime><ControlledSidePanel initialCollapsed /></TestRuntime>);
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());

    act(() => {
      location.hash = '#/t/t-abc/graph';
      window.dispatchEvent(new Event('hashchange'));
    });

    await waitFor(() => expect(screen.getByRole('tab', { name: 'graph' }).getAttribute('aria-selected')).toBe('true'));
    // A tab name alone is not a deep link to content — it must not reopen a panel the learner
    // deliberately collapsed. SidePanel's own write-back effect puts one of these in the hash on
    // almost every tab switch, so treating it as an open request reopened on nearly every reload.
    expect(railExpandBtn()).not.toBeNull();
    expect(collapseBtn()).toBeNull();
  });

  it('a hash naming only a tab (not a page) on first mount does not expand the panel, but still selects the tab', async () => {
    stubFetch();
    location.hash = '#/t/t-abc/library';
    render(<TestRuntime><ControlledSidePanel initialCollapsed /></TestRuntime>);
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());
    expect(collapseBtn()).toBeNull();
    expect(screen.getByRole('tab', { name: /^library/i }).getAttribute('aria-selected')).toBe('true');
  });

  it('a hash naming a page expands a collapsed panel on first mount', async () => {
    stubFetch();
    location.hash = '#/t/t-abc/page/derivatives';
    render(<TestRuntime><ControlledSidePanel initialCollapsed /></TestRuntime>);
    await waitFor(() => expect(collapseBtn()).not.toBeNull());
    expect(screen.getByRole('tab', { name: 'page' }).getAttribute('aria-selected')).toBe('true');
  });

  it('a hashchange to a page deep link expands a collapsed panel', async () => {
    stubFetch();
    location.hash = '#/t/t-abc';
    render(<TestRuntime><ControlledSidePanel initialCollapsed /></TestRuntime>);
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());

    act(() => {
      location.hash = '#/t/t-abc/page/derivatives';
      window.dispatchEvent(new Event('hashchange'));
    });

    await waitFor(() => expect(collapseBtn()).not.toBeNull());
    expect(screen.getByRole('tab', { name: 'page' }).getAttribute('aria-selected')).toBe('true');
  });

  it('reloading with collapsed=true in storage and a tab-naming hash stays collapsed and leaves storage untouched', async () => {
    localStorage.setItem(COLLAPSED_KEY, 'true');
    stubFetch();
    vi.stubGlobal('ResizeObserver', StubResizeObserver);
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
    location.hash = '#/t/t-abc/graph';

    await act(async () => { render(<App />); });

    await waitFor(() => expect(railExpandBtn()).not.toBeNull());
    expect(collapseBtn()).toBeNull();
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('true');
  });

  it('the map-as-home default (an un-named hash, known pages) never expands a collapsed panel', async () => {
    const KNOWN_NODES = [
      { slug: 'derivatives', title: 'Derivatives', prereqs: [], deepens: [], mastery: { effective: 'practicing' } },
    ];
    stubFetch({ nodes: KNOWN_NODES });
    location.hash = '#/t/t-abc';
    render(<TestRuntime><ControlledSidePanel initialCollapsed /></TestRuntime>);

    // Give the map-as-home effect's fetch a chance to resolve and (internally) flip the tab.
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/graph'));
    await act(async () => {});

    // Still a rail — the un-named default must lose to "stay collapsed", unlike an explicit deep link.
    expect(railExpandBtn()).not.toBeNull();
    expect(collapseBtn()).toBeNull();
  });

  it('ArrowDown in the rail moves focus to the next tab without activating it', async () => {
    stubFetch();
    location.hash = '#/t/t-abc';
    render(<TestRuntime><ControlledSidePanel initialCollapsed /></TestRuntime>);
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());

    const rail = screen.getByRole('tablist', { name: 'Workspace panels' });
    screen.getByRole('tab', { name: /^stage/i }).focus();
    fireEvent.keyDown(rail, { key: 'ArrowDown' });

    expect(document.activeElement?.textContent).toContain('graph');
    // Focus moved, but nothing was activated: the panel stays collapsed and the tab selection
    // (still stage) is unchanged — the bug this pins had ArrowDown click the newly-focused tab,
    // which expanded the panel, unmounted the rail out from under the roving-focus hook, and
    // dropped focus to <body>.
    expect(railExpandBtn()).not.toBeNull();
    expect(collapseBtn()).toBeNull();
    expect(screen.getByRole('tab', { name: /^stage/i }).getAttribute('aria-selected')).toBe('true');
  });

  it('Enter on a focused rail tab expands the panel onto that tab and moves focus into the strip', async () => {
    stubFetch();
    location.hash = '#/t/t-abc';
    render(<TestRuntime><ControlledSidePanel initialCollapsed /></TestRuntime>);
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());

    const rail = screen.getByRole('tablist', { name: 'Workspace panels' });
    screen.getByRole('tab', { name: /^graph/i }).focus();
    fireEvent.keyDown(rail, { key: 'Enter' });

    await waitFor(() => expect(collapseBtn()).not.toBeNull());
    const graphStripTab = screen.getByRole('tab', { name: 'graph' });
    expect(graphStripTab.getAttribute('aria-selected')).toBe('true');
    // The rail unmounted underneath the keypress that expanded it — without moving focus by hand,
    // it falls to <body> and a keyboard user loses their place entirely.
    expect(document.activeElement).toBe(graphStripTab);
  });
});

describe('App — Ctrl+\\ and focus mode', () => {
  it('Control+Backslash toggles the side panel collapsed from anywhere in the workspace', async () => {
    stubFetch();
    vi.stubGlobal('ResizeObserver', StubResizeObserver);
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

    // No stored preference: the panel starts collapsed.
    await act(async () => { render(<App />); });
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', ctrlKey: true, bubbles: true })); });
    await waitFor(() => expect(collapseBtn()).not.toBeNull());
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('false');

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', metaKey: true, bubbles: true })); });
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('true');
  });

  it('focus mode ignores the collapsed state, which returns once focus mode ends', async () => {
    localStorage.setItem(COLLAPSED_KEY, 'true');
    stubFetch();
    vi.stubGlobal('ResizeObserver', StubResizeObserver);
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
    scriptedContent = [
      { type: 'text' as const, text: "Let's practice." },
      {
        type: 'tool-call' as const,
        toolCallId: 'tc-code-exercise-1',
        toolName: 'code_exercise',
        argsText: JSON.stringify({ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }),
        args: { pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' },
      },
    ];
    autoKickMessage = true;

    // TestRuntime's own mount effect fires the scripted turn (autoKickMessage) fast enough that
    // waiting for an initial "collapsed, before focus mode" render would race it — the assertion
    // that matters is what happens once focus mode is confirmed on. stage-root always holds the
    // stage-empty placeholder, so its children.length alone is never zero; wait for the exercise
    // block itself (a lazy chunk, per app-focus-mode.test.tsx) — that's the mount that flips focus
    // mode, and checking the placeholder count instead raced it and lost under master's heavier
    // App tree (ErrorBoundary, notebooksRoute, the splitter).
    await act(async () => { render(<App />); });
    await waitFor(() => {
      expect(document.querySelector('#stage-root .code-exercise')).not.toBeNull();
    });
    expect(document.querySelector('.app.focus-mode')).not.toBeNull();

    // Collapsed is suppressed while the exercise needs the panel.
    expect(railExpandBtn()).toBeNull();

    act(() => { panelBus.setFocusMode(false); });
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());
  });
});

describe('SidePanel — empty Stage', () => {
  it('a brand-new conversation shows the micro-label and the line, never the old card or buttons', async () => {
    stubFetch();
    location.hash = '#/t/t-abc';
    render(<TestRuntime><ControlledSidePanel /></TestRuntime>);
    await waitFor(() => expect(collapseBtn()).not.toBeNull());

    expect(screen.getByRole('heading', { name: 'stage' })).toBeTruthy();
    expect(screen.getByText('Quizzes and exercises the tutor sets land here.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your workspace' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Browse library' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Explore knowledge graph' })).toBeNull();
  });

  it('the quiz shortcut stays hidden with nothing yet for the tutor to quiz', async () => {
    stubFetch();
    location.hash = '#/t/t-abc';
    render(<TestRuntime><ControlledSidePanel /></TestRuntime>);
    await waitFor(() => expect(collapseBtn()).not.toBeNull());

    expect(screen.queryByRole('button', { name: 'Quiz me on this conversation' })).toBeNull();
  });

  it('the quiz shortcut appears once the tutor has said something, and sends the fixed askTutor text', async () => {
    initialChatMessages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Explain derivatives.' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'A derivative measures rate of change.' }] },
    ];
    stubFetch();
    location.hash = '#/t/t-abc';
    render(<TestRuntime><ControlledSidePanel /></TestRuntime>);
    await waitFor(() => expect(collapseBtn()).not.toBeNull());

    const quizBtn = screen.getByRole('button', { name: 'Quiz me on this conversation' });
    expect(quizBtn).toBeTruthy();

    const seen: string[] = [];
    const unsub = panelBus.subscribe((e) => { if (e.type === 'askTutor') seen.push(e.text); });
    fireEvent.click(quizBtn);
    unsub();
    expect(seen).toEqual(["Quiz me on what we've covered in this conversation."]);
  });
});

describe('SidePanel — a reply while the panel is open', () => {
  // On a phone the open panel covers the chat, so the tutor can answer out of sight — a grading
  // turn after a stage Submit does. The collapse button (the phone's "Chat") says so in its name.
  const atWidth = (phone: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === '(max-width: 640px)', media: query,
    addEventListener() {}, removeEventListener() {},
  }));
  const reply = (store: ChatStore) => act(() => store.setMessages([
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: '6' }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Right.' }] },
  ]));

  it('at desktop width the chat is in view, so a reply changes nothing', async () => {
    atWidth(false);
    let store: ChatStore | null = null;
    function Grab() { store = useContext(ChatStoreContext); return null; }
    stubFetch();
    location.hash = '#/t/t-abc';
    render(<TestRuntime><Grab /><ControlledSidePanel /></TestRuntime>);
    await waitFor(() => expect(collapseBtn()).not.toBeNull());
    reply(store!);
    expect(collapseBtn()).not.toBeNull();
  });

  it('on a phone, names a reply that arrived after the panel opened, and forgets it once the panel closes', async () => {
    atWidth(true);
    let store: ChatStore | null = null;
    function Grab() { store = useContext(ChatStoreContext); return null; }
    stubFetch();
    location.hash = '#/t/t-abc';
    render(<TestRuntime><Grab /><ControlledSidePanel /></TestRuntime>);
    await waitFor(() => expect(collapseBtn()).not.toBeNull());

    reply(store!);
    const named = screen.getByRole('button', { name: 'Collapse side panel (new reply in chat)' });

    fireEvent.click(named);
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());
    fireEvent.click(railExpandBtn()!);
    // Reopened after reading it: nothing new since.
    await waitFor(() => expect(collapseBtn()).not.toBeNull());
  });
});
