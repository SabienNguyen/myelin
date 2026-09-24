// @vitest-environment jsdom
// Regression test: the notebooks screens (#/notebooks, #/notebooks/<id>) used to swap in a topbar
// with no HistoryMenu and a plain, unlinked wordmark — only Ctrl K or the browser's Back button
// led back to the open conversation. The wordmark now links to the conversation App still holds
// while those screens show, and the notebooks topbar carries its own HistoryMenu so picking a
// conversation there leaves the notebooks screen the same way it does from the workspace.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { useState, type PropsWithChildren } from 'react';
import { AssistantRuntimeProvider, Tools, useAui, useLocalRuntime } from '@assistant-ui/react';
import { ChatStore, ChatStoreContext } from '../../src/client/chatCore/index.js';
import { toolkit } from '../../src/client/toolkit.js';

// Swap out Runtime.tsx's real chat wiring (network fetch + AI SDK transport) for a minimal, real
// assistant-ui local runtime — this test never sends a message, it only needs the composer and
// the rest of the workspace chrome to mount. Same stand-in as app-focus-mode.test.tsx.
function TestRuntime({ children }: PropsWithChildren<Record<string, unknown>>) {
  const runtime = useLocalRuntime({
    async run() { return { content: [{ type: 'text' as const, text: '' }] }; },
  });
  const aui = useAui({ tools: Tools({ toolkit }) });
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

// jsdom has no ResizeObserver, and its elements have no scrollTo — assistant-ui's real
// ThreadPrimitive.Viewport (Thread.tsx uses it) needs both to exist at all, unrelated to what
// this test actually checks.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/threads') {
      return {
        ok: true,
        json: async () => ([
          { id: 't-chosen', title: 'Derivatives', updatedAt: new Date().toISOString(), messages: 3 },
        ]),
      } as any;
    }
    if (url === '/api/notebooks') {
      return { ok: true, json: async () => ({ notebooks: [], unfiled: [] }) } as any;
    }
    // The setup gate, NotebookCrumb, TopbarStatus, SidePanel's own fetches, etc. — resolve
    // quietly, this test isn't exercising any of them.
    return { ok: true, json: async () => ({}) } as any;
  }));
}

describe('Notebooks screens — a way back to the conversation', () => {
  beforeEach(() => {
    stubFetch();
    vi.stubGlobal('ResizeObserver', StubResizeObserver);
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
    location.hash = '';
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    location.hash = '';
  });

  it('the wordmark links to the held conversation, and picking one from history leaves the notebooks screen', async () => {
    location.hash = '#/t/t-existing';
    await act(async () => {
      render(<App />);
    });

    // Navigate to the notebooks home the way NotebookCrumb's link does. App's threadId slice is
    // untouched (App.tsx's hashchange handler returns early for a notebook route), so it still
    // holds t-existing underneath.
    act(() => {
      location.hash = '#/notebooks';
      window.dispatchEvent(new Event('hashchange'));
    });

    const wordmark = await screen.findByRole('link', { name: /myelin/i });
    expect(wordmark.getAttribute('href')).toBe('#/t/t-existing');

    fireEvent.click(screen.getByRole('button', { name: 'Conversation history' }));
    const chosenRow = await screen.findByRole('menuitem', { name: /derivatives/i });
    fireEvent.click(chosenRow);

    // The workspace's composer is the concrete sign the notebooks screen is gone, not just some
    // other empty state — CommandEditor.tsx gives it an explicit textbox role and this label.
    await screen.findByRole('textbox', { name: /ask your tutor/i });
    expect(location.hash).toBe('#/t/t-chosen');
  });
});
