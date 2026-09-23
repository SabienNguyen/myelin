// @vitest-environment jsdom
//
// Chat first, study on demand (plans/2026-09-22-chat-first.md, C3), through the real
// Runtime -> useChatCoreRuntime -> Thread wiring with App's own mode state in a small harness:
// chat has no chip and offers two quiet ways into study under a substantive answer; /study (here
// through the "study this" chip) makes the tutor sticky until the composer's `end` clears it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { useState } from 'react';
import { Thread } from '../../src/client/components/Thread.js';
import { Runtime } from '../../src/client/runtime.js';
import type { UIMessage } from '../../src/shared/uiMessages.js';
import { sseResponse, sseText } from './chatCore/sse.js';

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
  // Tiptap destroys its editor on a 1ms timer after unmount; let it run while jsdom is alive
  // (threadAside.test.tsx explains the unhandled error this avoids).
  await new Promise((resolve) => setTimeout(resolve, 10));
  vi.unstubAllGlobals();
});

const LONG_ANSWER = 'A monad is a way to chain computations that carry context — optional values, '
  + 'errors, state — so each step sees a plain value and the context rides along underneath. '
  + 'The two operations are return, which wraps a value, and bind, which feeds a wrapped value '
  + 'into the next step.';

const answerChunks = (messageId: string, text: string, finishReason = 'stop'): unknown[] => [
  { type: 'start', messageId },
  { type: 'start-step' },
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: text },
  { type: 'text-end', id: '0' },
  { type: 'finish-step' },
  { type: 'finish', finishReason },
];

// How the server closes a turn that explained its own failure in the message (wire.ts's
// emptyText/onError notes): the note is ordinary text, only the finish reason says it failed.
const FAILED = 'failed:';

interface ChatBody { mode?: string; command?: string; messages: UIMessage[] }

/** Serves the thread load, an empty session plan, and each /api/chat POST from `replies` in order,
 *  recording every chat body. */
function stubServer(initial: UIMessage[], replies: string[] = [], plan: unknown[] = []) {
  const chats: ChatBody[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/thread/test') return { ok: true, json: async () => initial } as Response;
    if (url === '/api/session-plan') return { ok: true, json: async () => ({ plan }) } as Response;
    if (url === '/api/chat') {
      chats.push(JSON.parse(String(init?.body)));
      const text = replies[chats.length - 1];
      if (text === undefined) throw new Error(`unscripted /api/chat call #${chats.length}`);
      return sseResponse(sseText(text.startsWith(FAILED)
        ? answerChunks(`reply-${chats.length}`, text.slice(FAILED.length), 'error')
        : answerChunks(`reply-${chats.length}`, text)));
    }
    return { ok: true, json: async () => ({}) } as Response;
  }));
  return chats;
}

function Harness() {
  const [mode, setMode] = useState('');
  return (
    <Runtime mode={mode} threadId="test" onSetMode={setMode}>
      <Thread mode={mode} onModeChange={setMode} />
    </Runtime>
  );
}

async function renderThread() {
  await act(async () => { render(<Harness />); });
  // The composer's editor autofocuses once, asynchronously; let it settle before interacting.
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
}

const lastUserText = (body: ChatBody) => {
  const user = [...body.messages].reverse().find((m) => m.role === 'user')!;
  return user.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
};

const answered: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'what is a monad?' }] },
  { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: LONG_ANSWER }] },
];

describe('the empty thread', () => {
  it('asks what to explore, with a returning learner\'s plan as the way into study beneath it', async () => {
    stubServer([], [], [{ kind: 'review', slug: 'limits', title: 'Limits', why: 'due' }]);
    await renderThread();
    expect(await screen.findByRole('heading', { name: 'What do you want to explore?' })).not.toBeNull();
    expect(screen.getByRole('button', { name: /Start today’s session/ })).not.toBeNull();
  });

  it('starting the plan runs it as /study, on the tutor', async () => {
    const chats = stubServer([], [LONG_ANSWER], [{ kind: 'new', slug: 'limits', title: 'Limits', why: 'next' }]);
    await renderThread();
    fireEvent.click(await screen.findByRole('button', { name: /Start today’s session/ }));
    await waitFor(() => expect(chats).toHaveLength(1));
    expect(chats[0].command).toBe('study');
    expect(lastUserText(chats[0])).toMatch(/^Run today's session/);
    expect(await screen.findByRole('button', { name: 'end study session' })).not.toBeNull();
  });
});

describe('follow-up chips in chat', () => {
  it('"check my understanding" sends a plain chat message: no command, no mode', async () => {
    const chats = stubServer(answered, [LONG_ANSWER]);
    await renderThread();
    fireEvent.click(await screen.findByRole('button', { name: 'check my understanding' }));
    await waitFor(() => expect(chats).toHaveLength(1));
    expect(lastUserText(chats[0])).toBe('Check my understanding of this with one quick question.');
    expect(chats[0].command).toBeUndefined();
    expect(chats[0].mode).toBeUndefined();
  });

  it('"study this" starts a sticky study session that the composer chip ends', async () => {
    const chats = stubServer(answered, [LONG_ANSWER, LONG_ANSWER]);
    await renderThread();
    expect(screen.queryByRole('button', { name: 'end study session' })).toBeNull(); // chat: no chip

    fireEvent.click(await screen.findByRole('button', { name: 'study this' }));
    await waitFor(() => expect(chats).toHaveLength(1));
    expect(chats[0].command).toBe('study');
    expect(lastUserText(chats[0])).toBe('Teach me what we were just discussing, properly.');

    const end = await screen.findByRole('button', { name: 'end study session' });
    expect(screen.getByText('studying')).not.toBeNull();
    // Studying, the chat-only chips step aside.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'study this' })).toBeNull());

    fireEvent.click(end);
    expect(screen.queryByRole('button', { name: 'end study session' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'check my understanding' }));
    await waitFor(() => expect(chats).toHaveLength(2));
    expect(chats[1].mode).toBeUndefined(); // back to chat: the server derives the mode again
  });

  it('only under the newest answer, and not after a short reply', async () => {
    stubServer([
      ...answered,
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'thanks' }] },
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Any time.' }] },
    ]);
    await renderThread();
    await screen.findByText('Any time.');
    expect(screen.queryByRole('button', { name: 'check my understanding' })).toBeNull();
  });

  it('not under a turn that failed and said so', async () => {
    const note = 'The tutor model returned nothing for this turn — no answer and no block staged. '
      + 'Nothing you did was lost. Send your message again, or point the tutor role at a different '
      + 'model from the model badge in the top bar.';
    stubServer(answered, [`${FAILED}${note}`]);
    await renderThread();
    fireEvent.click(await screen.findByRole('button', { name: 'check my understanding' }));
    await screen.findByText(/returned nothing for this turn/);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.queryByRole('button', { name: 'check my understanding' })).toBeNull();
  });

  it('not while a block waits for the learner\'s answer', async () => {
    stubServer([
      answered[0],
      { id: 'a1', role: 'assistant', parts: [
        { type: 'text', text: LONG_ANSWER },
        { type: 'tool-quick_check', toolCallId: 'tc1', state: 'input-available', input: { question: 'What does bind do?' } },
      ] },
    ] as UIMessage[]);
    await renderThread();
    await screen.findByText(/A monad is a way to chain/);
    expect(screen.queryByRole('button', { name: 'check my understanding' })).toBeNull();
  });

  it('step aside once the learner starts typing', async () => {
    stubServer(answered);
    await renderThread();
    await screen.findByRole('button', { name: 'check my understanding' });
    const editor = (document.querySelector('.tiptap') as unknown as { editor: { commands: { insertContent(t: string): void } } }).editor;
    act(() => { editor.commands.insertContent('so what about'); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'check my understanding' })).toBeNull());
  });
});

describe('"quiz me on this" on a selected passage', () => {
  it('sends the passage, quoted, as a chat turn the quiz patterns route', async () => {
    const chats = stubServer(answered, [LONG_ANSWER]);
    await renderThread();
    const para = await screen.findByText(/A monad is a way to chain/);
    const range = document.createRange();
    range.setStart(para.firstChild!, 2);
    range.setEnd(para.firstChild!, 7);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    fireEvent.click(await screen.findByRole('button', { name: 'quiz me on this' }));
    await waitFor(() => expect(chats).toHaveLength(1));
    expect(lastUserText(chats[0])).toBe('Quiz me on this:\n\n> monad');
    expect(chats[0].command).toBeUndefined();
  });
});
