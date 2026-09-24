// @vitest-environment jsdom
//
// The composer while a turn streams (Stop, Escape) and between visits (the per-thread draft),
// through the real Runtime -> useChatCoreRuntime -> Thread wiring.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { Thread } from '../../src/client/components/Thread.js';
import { Runtime } from '../../src/client/runtime.js';
import type { UIMessage } from '../../src/shared/uiMessages.js';

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  (Range.prototype as any).getBoundingClientRect ??=
    () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  (Range.prototype as any).getClientRects ??= () => [];
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
afterEach(async () => {
  cleanup();
  // Tiptap destroys its editor on a 1ms timer after unmount (threadAside.test.tsx explains).
  await new Promise((resolve) => setTimeout(resolve, 10));
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const answered: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'what is a limit?' }] },
  // Long enough (200+ characters) for the "check my understanding" follow-up that starts a turn.
  { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'A limit is the value a function approaches as its input approaches some point. '
    + 'It does not care what the function does AT that point, only near it, which is why a hole in a graph still has a limit. '
    + 'Derivatives are built from exactly this idea.' }] },
];

/** /api/chat streams the start of an answer and then holds the connection open, the way a long
 *  turn looks mid-stream. Every request is recorded. */
function stubStreamingServer(initial: UIMessage[]) {
  const calls: { url: string; method: string }[] = [];
  const encoder = new TextEncoder();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url === '/api/thread/test') return { ok: true, json: async () => initial } as Response;
    if (url === '/api/session-plan') return { ok: true, json: async () => ({ plan: [] }) } as Response;
    if (url === '/api/chat') {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (const chunk of [
            { type: 'start', messageId: 'streaming' }, { type: 'start-step' },
            { type: 'text-start', id: '0' }, { type: 'text-delta', id: '0', delta: 'Half an answer' },
          ]) c.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return { ok: true, status: 200, body } as unknown as Response;
    }
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  }));
  return calls;
}

async function renderThread() {
  await act(async () => { render(<Runtime mode="" threadId="test"><Thread threadId="test" /></Runtime>); });
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
}

const editor = () => (document.querySelector('.tiptap') as unknown as {
  editor: { commands: { insertContent(t: string): void }; getText(): string };
}).editor;

async function startTurn() {
  fireEvent.click(await screen.findByRole('button', { name: 'check my understanding' }));
  await screen.findByText('Half an answer');
}

describe('stopping a streaming turn', () => {
  it('Stop replaces Send while the turn runs and stops it on the server', async () => {
    const calls = stubStreamingServer(answered);
    await renderThread();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    await startTurn();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(calls).toContainEqual({ url: '/api/thread/test/stop', method: 'POST' }));
    expect(await screen.findByRole('button', { name: 'Send' })).not.toBeNull();
  });

  it('Escape in the composer stops it too', async () => {
    const calls = stubStreamingServer(answered);
    await renderThread();
    await startTurn();
    fireEvent.keyDown(document.querySelector('.tiptap')!, { key: 'Escape' });
    await waitFor(() => expect(calls).toContainEqual({ url: '/api/thread/test/stop', method: 'POST' }));
  });

  it('the answer still being written offers no aside; earlier answers do', async () => {
    stubStreamingServer(answered);
    await renderThread();
    await startTurn();
    const asks = screen.getAllByRole('button', { name: 'ask aside about this answer' }) as HTMLButtonElement[];
    expect(asks.map((b) => b.disabled)).toEqual([false, true]);
  });
});

describe('the unsent draft', () => {
  it('comes back after the composer unmounts, and is forgotten once sent', async () => {
    stubStreamingServer(answered);
    await renderThread();
    act(() => { editor().commands.insertContent('half a thought'); });
    cleanup();
    await new Promise((r) => setTimeout(r, 10));

    await renderThread();
    expect(editor().getText()).toBe('half a thought');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Half an answer');
    expect(sessionStorage.getItem('myelin.draft.test')).toBeNull();
  });
});
