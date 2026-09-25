// @vitest-environment jsdom
//
// Regression for the P1 measurement bug: App's workspace-width effect used to run once on mount
// (`useEffect(() => {...}, [])`) against a plain `useRef`. Runtime renders null for one frame while
// the thread loads (see runtime.tsx), so `<main ref={workspaceRef}>` does not exist yet when that
// effect fires — the ref stays null, the effect never re-runs, and every panel width clamps to
// MIN_PANEL_WIDTH forever. This mounts App the same way with the thread load resolving AFTER
// App's first render, which reproduces the bug, then confirms a real container width is measured
// once `<main>` actually appears.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { useEffect, useState, type PropsWithChildren } from 'react';
import { AssistantRuntimeProvider, Tools, useAui, useLocalRuntime } from '@assistant-ui/react';
import { ChatStore, ChatStoreContext } from '../../src/client/chatCore/index.js';
import { toolkit } from '../../src/client/toolkit.js';

// Stands in for the real Runtime's `initial === null` frame (runtime.tsx: "one settled frame
// while the thread restores"): renders null on mount, then the children one microtask later, so
// App's own first-render effects run before `<main ref={workspaceRef}>` exists — same race that
// bit App.tsx in production.
function DelayedTestRuntime({ children }: PropsWithChildren<Record<string, unknown>>) {
  const [ready, setReady] = useState(false);
  useEffect(() => { void Promise.resolve().then(() => setReady(true)); }, []);
  const runtime = useLocalRuntime({ async run() { return { content: [{ type: 'text', text: '' }] } as any; } });
  const aui = useAui({ tools: Tools({ toolkit }) });
  const [store] = useState(() => new ChatStore({
    threadId: 'test', initialMessages: [],
    requestContext: () => ({ mode: 'learn', writeUp: false }),
  }));
  if (!ready) return null;
  return (
    <ChatStoreContext.Provider value={store}>
      <AssistantRuntimeProvider runtime={runtime} aui={aui}>{children}</AssistantRuntimeProvider>
    </ChatStoreContext.Provider>
  );
}
vi.mock('../../src/client/runtime.js', () => ({ Runtime: DelayedTestRuntime }));
const { App } = await import('../../src/client/App.js');

/** Reports a fixed contentRect.width for whatever element it observes — a fake, not a stub that
 *  no-ops: the bug is specifically about whether the real element ever gets observed at all, so a
 *  test that never calls back would pass whether App wires the ref correctly or not. */
class FakeResizeObserver {
  #cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.#cb = cb; }
  observe(target: Element) {
    this.#cb([{ target, contentRect: { width: 1400 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.startsWith('/api/graph')) return { ok: true, json: async () => ({ nodes: [] }) } as any;
    if (u.startsWith('/api/due')) return { ok: true, json: async () => ({ total: 0 }) } as any;
    return { ok: true, json: async () => ({}) } as any;
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  location.hash = '';
});

describe('App measures the workspace container once <main> actually mounts', () => {
  it('reports a real aria-valuemax (not the MIN_PANEL_WIDTH floor) once the deferred Runtime renders <main>', async () => {
    stubFetch();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
    localStorage.clear();
    location.hash = '#/t/t-abc';

    await act(async () => { render(<App />); });

    const separator = await waitFor(() => screen.getByRole('separator', { name: 'Resize side panel' }));

    // 1400 (fake container width) - 420 (MIN_CHAT_WIDTH) = 980. Before the fix this was 320
    // (MIN_PANEL_WIDTH), because containerWidth never left 0.
    await waitFor(() => expect(separator.getAttribute('aria-valuemax')).toBe('980'));

    const before = Number(separator.getAttribute('aria-valuenow'));
    separator.focus();
    act(() => { separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); });
    await waitFor(() => expect(Number(separator.getAttribute('aria-valuenow'))).toBeGreaterThan(before));
  });
});
