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
import { useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { AssistantRuntimeProvider, Tools, useAui, useLocalRuntime } from '@assistant-ui/react';
import { ChatStore, ChatStoreContext } from '../../src/client/chatCore/index.js';
import { toolkit } from '../../src/client/toolkit.js';
import { panelBus } from '../../src/client/lib/panelBus.js';
import { SidePanel } from '../../src/client/components/SidePanel.js';

const COLLAPSED_KEY = 'myelin.sidePanel.collapsed';

// One scripted turn, its content swappable per test: most tests never send a message at all (App
// mounts and sits idle), the focus-mode test below needs the exact code_exercise mount-with-no-
// result payload app-focus-mode.test.tsx reproduced the P1 remount bug against. autoKickMessage
// gates whether TestRuntime sends it at all — most tests here want an idle thread.
let scriptedContent: unknown[] = [{ type: 'text' as const, text: '' }];
let autoKickMessage = false;

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
    threadId: 'test', initialMessages: [],
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

  it('a hash change that names a tab expands a collapsed panel', async () => {
    stubFetch();
    location.hash = '#/t/t-abc';
    render(<TestRuntime><ControlledSidePanel initialCollapsed /></TestRuntime>);
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());

    act(() => {
      location.hash = '#/t/t-abc/graph';
      window.dispatchEvent(new Event('hashchange'));
    });

    await waitFor(() => expect(collapseBtn()).not.toBeNull());
    expect(screen.getByRole('tab', { name: 'graph' }).getAttribute('aria-selected')).toBe('true');
  });

  it('a hash that already names a tab on first mount expands the panel too', async () => {
    stubFetch();
    location.hash = '#/t/t-abc/library';
    render(<TestRuntime><ControlledSidePanel initialCollapsed /></TestRuntime>);
    await waitFor(() => expect(collapseBtn()).not.toBeNull());
    expect(screen.getByRole('tab', { name: /^library/i }).getAttribute('aria-selected')).toBe('true');
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
});

describe('App — Ctrl+\\ and focus mode', () => {
  it('Control+Backslash toggles the side panel collapsed from anywhere in the workspace', async () => {
    stubFetch();
    vi.stubGlobal('ResizeObserver', StubResizeObserver);
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

    await act(async () => { render(<App />); });
    await waitFor(() => expect(collapseBtn()).not.toBeNull());

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', ctrlKey: true, bubbles: true })); });
    await waitFor(() => expect(railExpandBtn()).not.toBeNull());
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('true');

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', metaKey: true, bubbles: true })); });
    await waitFor(() => expect(collapseBtn()).not.toBeNull());
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('false');
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
