// @vitest-environment jsdom
//
// Cross-screen flows as App wires them, with the real Runtime and a route-table fetch stub: the
// notebooks screens and back, a study session surviving a look at another conversation, and the
// topbar staying mounted through a thread switch. Every other client test renders one component
// alone, so these seams (App's hash handling, its per-thread mode, the Runtime key) had none.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { App } from '../../src/client/App.js';
import type { UIMessage } from '../../src/shared/uiMessages.js';
import { sseResponse, sseText } from './chatCore/sse.js';

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const LONG_ANSWER = 'A monad is a way to chain computations that carry context — optional values, '
  + 'errors, state — so each step sees a plain value and the context rides along underneath. '
  + 'The two operations are return, which wraps a value, and bind, which feeds a wrapped value '
  + 'into the next step.';

const threads: Record<string, UIMessage[]> = {
  a: [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'what is a monad?' }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: LONG_ANSWER }] },
  ],
  b: [],
};

let chats: { command?: string }[];

beforeEach(() => {
  chats = [];
  (Range.prototype as any).getBoundingClientRect ??=
    () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  (Range.prototype as any).getClientRects ??= () => [];
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const thread = /^\/api\/thread\/([^/]+)$/.exec(url);
    if (thread && method === 'GET') return { ok: true, json: async () => threads[thread[1]!] ?? [] } as Response;
    if (url === '/api/chat') {
      chats.push(JSON.parse(String(init?.body)));
      return sseResponse(sseText([
        { type: 'start', messageId: `reply-${chats.length}` }, { type: 'start-step' },
        { type: 'text-start', id: '0' }, { type: 'text-delta', id: '0', delta: LONG_ANSWER },
        { type: 'text-end', id: '0' }, { type: 'finish-step' }, { type: 'finish', finishReason: 'stop' },
      ]));
    }
    if (url === '/api/session-plan') return { ok: true, json: async () => ({ plan: [] }) } as Response;
    if (url === '/api/notebooks') return { ok: true, json: async () => ({ notebooks: [], unfiled: [] }) } as Response;
    const run = /^\/api\/thread\/([^/]+)\/run$/.exec(url);
    if (run) return { ok: true, json: async () => ({ running: false, messages: threads[run[1]!] ?? [] }) } as Response;
    return { ok: true, json: async () => ({}) } as Response;
  }));
  history.replaceState(null, '', '#/t/a');
});
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 10)); // Tiptap's deferred destroy
  vi.unstubAllGlobals();
  sessionStorage.clear();
  history.replaceState(null, '', '#');
});

async function go(hash: string) {
  await act(async () => {
    location.hash = hash;
    await new Promise((r) => setTimeout(r, 0));
  });
}

const announcer = () => document.querySelector('.app > [role="status"]')!;

describe('App flows', () => {
  it('goes to the notebooks screen and back to the same conversation, announcing each', async () => {
    await act(async () => { render(<App />); });
    expect(await screen.findByText(/A monad is a way to chain/, { selector: '.msg.assistant *' })).not.toBeNull();
    expect(announcer().textContent).toBe('');

    await go('#/notebooks');
    await waitFor(() => expect(document.querySelector('.notebooks-main')).not.toBeNull());
    expect(document.querySelector('.thread')).toBeNull();
    expect(announcer().textContent).toBe('notebooks opened');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Notebooks' }));

    await go('#/t/a');
    expect(await screen.findByText(/A monad is a way to chain/, { selector: '.msg.assistant *' })).not.toBeNull();
    expect(announcer().textContent).toBe('conversation opened');
  });

  it('keeps a study session with its conversation across a look at another one', async () => {
    await act(async () => { render(<App />); });
    fireEvent.click(await screen.findByRole('button', { name: 'study this' }));
    await waitFor(() => expect(chats).toHaveLength(1));
    expect(chats[0]!.command).toBe('study');
    expect(await screen.findByRole('button', { name: 'end study session' })).not.toBeNull();

    await go('#/t/b');
    await screen.findByRole('heading', { name: 'What do you want to explore?' });
    expect(screen.queryByRole('button', { name: 'end study session' })).toBeNull();

    await go('#/t/a');
    expect(await screen.findByRole('button', { name: 'end study session' })).not.toBeNull();
  });

  it('keeps the topbar mounted through a thread switch', async () => {
    await act(async () => { render(<App />); });
    await screen.findByText(/A monad is a way to chain/, { selector: '.msg.assistant *' });
    const topbar = document.querySelector('.topbar');
    await go('#/t/b');
    await screen.findByRole('heading', { name: 'What do you want to explore?' });
    expect(document.querySelector('.topbar')).toBe(topbar);
  });
});
