// @vitest-environment jsdom
//
// Chat first, study on demand (plans/2026-09-22-chat-first.md, C3), through the real
// Runtime -> useChatCoreRuntime -> Thread wiring with App's own mode state in a small harness:
// chat has no chip and offers two quiet ways into study under a substantive answer; /study (here
// through the "study this" chip) makes the tutor sticky until the composer's `end` clears it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { setPendingAsk } from '../../src/client/lib/pendingAsk.js';
import { Thread, missedOn } from '../../src/client/components/Thread.js';
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
  sessionStorage.clear(); // a typed draft is kept per thread and would reach the next test
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
 *  recording every chat body. `routes` answers other GETs first (a notebook, a failing plan). */
function stubServer(
  initial: UIMessage[], replies: string[] = [], plan: unknown[] = [],
  routes: Record<string, () => unknown> = {},
) {
  const chats: ChatBody[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (routes[url]) return routes[url]() as Response;
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

function Harness({ threadId }: { threadId?: string }) {
  const [mode, setMode] = useState('');
  return (
    <Runtime mode={mode} threadId="test" onSetMode={setMode}>
      <Thread mode={mode} onModeChange={setMode} threadId={threadId} />
    </Runtime>
  );
}

async function renderThread(threadId?: string) {
  await act(async () => { render(<Harness threadId={threadId} />); });
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

describe('the plan one item at a time', () => {
  it('each row of the plan starts a session of just that item', async () => {
    const chats = stubServer([], [LONG_ANSWER], [
      { kind: 'review', slug: 'limits', title: 'Limits', why: 'due' },
      { kind: 'new', slug: 'continuity', title: 'Continuity', why: 'next' },
    ]);
    await renderThread();
    fireEvent.click(await screen.findByRole('button', { name: /Learn Continuity/ }));
    await waitFor(() => expect(chats).toHaveLength(1));
    expect(chats[0].command).toBe('study');
    expect(lastUserText(chats[0])).toContain('1. [new] "continuity"');
    expect(lastUserText(chats[0])).not.toContain('limits');
  });
});

const quizMiss: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me on derivatives' }] },
  { id: 'a1', role: 'assistant', parts: [
    { type: 'tool-quiz', toolCallId: 'q1', state: 'output-available',
      input: { title: 'Derivatives', items: [{ id: 'a', prompt: 'Differentiate x^3.' }, { id: 'b', prompt: 'What is a limit?' }] },
      output: { answers: [], grading: { verdict: 'partial', detail: '1 of 2', perItem: [{ id: 'a', correct: false }, { id: 'b', correct: true }] } } } as any,
    { type: 'text', text: LONG_ANSWER },
  ] },
];

describe('after a miss', () => {
  it('names what was missed from a quiz, a single check, or nothing to name', () => {
    expect(missedOn(quizMiss[1])).toEqual(['Differentiate x^3.']);
    const qc = (verdict: string) => ({ id: 'a', role: 'assistant', parts: [{ type: 'tool-quick_check', toolCallId: 'c', state: 'output-available',
      input: { question: 'What is 2+2?' }, output: { grading: { verdict, detail: '' } } }] }) as any as UIMessage;
    expect(missedOn(qc('incorrect'))).toEqual(['What is 2+2?']);
    expect(missedOn(qc('correct'))).toBeNull();
    expect(missedOn(answered[1])).toBeNull();
  });

  it('offers practising the missed item instead of the generic chips, and asks for a fresh question on it', async () => {
    const chats = stubServer(quizMiss, [LONG_ANSWER]);
    await renderThread();
    const practise = await screen.findByRole('button', { name: 'practise the one I missed' });
    expect(screen.queryByRole('button', { name: 'check my understanding' })).toBeNull();
    fireEvent.click(practise);
    await waitFor(() => expect(chats).toHaveLength(1));
    expect(lastUserText(chats[0])).toMatch(/^I missed “Differentiate x\^3\.”\. Give me a fresh question on it/);
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

  it('a failed turn offers "try again", which asks the same question again', async () => {
    const note = 'The tutor model returned nothing for this turn — no answer and no block staged.';
    const chats = stubServer(answered, [`${FAILED}${note}`, LONG_ANSWER]);
    await renderThread();
    fireEvent.click(await screen.findByRole('button', { name: 'check my understanding' }));
    const retry = await screen.findByRole('button', { name: 'try again' });
    expect(screen.queryByRole('button', { name: 'check my understanding' })).toBeNull();
    fireEvent.click(retry);
    await waitFor(() => expect(chats).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'try again' })).toBeNull());
    const asked = (body: ChatBody) => body.messages.filter((m) => m.role === 'user').at(-1)!
      .parts.map((p: any) => p.text ?? '').join('');
    expect(asked(chats[1])).toBe(asked(chats[0]));
    // The failure stays in the transcript, as it does on disk.
    expect(screen.getByText(/returned nothing for this turn/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'try again' })).toBeNull();
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

describe('a first message handed over from another screen', () => {
  it('is sent exactly once, with its command, even under StrictMode', async () => {
    setPendingAsk('test', { text: 'Quiz me across Calculus I. One question per page.', command: 'quiz' });
    const chats = stubServer([], [LONG_ANSWER]);
    function Strict() {
      const [mode, setMode] = useState('');
      return (
        <StrictMode>
          <Runtime mode={mode} threadId="test" onSetMode={setMode}>
            <Thread mode={mode} onModeChange={setMode} threadId="test" />
          </Runtime>
        </StrictMode>
      );
    }
    await act(async () => { render(<Strict />); });
    await screen.findByText(/A monad is a way to chain computations/);
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(chats).toHaveLength(1);
    expect(chats[0].command).toBe('quiz');
    expect(lastUserText(chats[0])).toBe('Quiz me across Calculus I. One question per page.');
  });
});

describe('"try again" after a failed grading turn', () => {
  it('resubmits the answer instead of asking the question again', async () => {
    const staged: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'check me' }] },
      { id: 'a1', role: 'assistant', parts: [
        { type: 'step-start' },
        { type: 'tool-quick_check', toolCallId: 'qc1', state: 'input-available',
          input: { question: 'What is 2+2?', mode: 'choice', choices: ['3', '4'], expected: '4', pageSlug: 'arith' } } as any,
      ] },
    ];
    const chats = stubServer(staged, [`${FAILED}The tutor model returned nothing for this turn.`, 'Right — four.']);
    await renderThread();
    fireEvent.click(await screen.findByRole('button', { name: '4' }));
    const retry = await screen.findByRole('button', { name: 'try again' });
    fireEvent.click(retry);
    await waitFor(() => expect(chats).toHaveLength(2));
    // The same history goes back, answer included, with no new question appended.
    const users = (body: ChatBody) => body.messages.filter((m) => m.role === 'user').length;
    expect(users(chats[1])).toBe(users(chats[0]));
    expect(chats[1].messages.at(-1)?.role).toBe('assistant');
  });
});

const json = (body: unknown, status = 200) => () => ({ ok: status < 400, status, json: async () => body });

describe('a conversation filed under a notebook', () => {
  const detail = {
    notebook: { id: 'calc', title: 'Calculus I', sources: 1, topics: 2, due: 1, lastActive: '2026-09-22T00:00:00.000Z', mastery: {} },
    threads: [], sources: [], library: [],
    topics: [
      { slug: 'derivative', title: 'Derivative', level: 'practicing', due: true },
      { slug: 'limits', title: 'Limits', level: 'unseen', due: false },
    ],
  };
  const plan = [
    { kind: 'review', slug: 'derivative', title: 'Derivative', why: 'due' },
    { kind: 'review', slug: 'entropy', title: 'Entropy', why: 'due in Thermodynamics' },
  ];

  it('opens on the notebook, starts from its topics, and studies only its pages', async () => {
    const chats = stubServer([], [LONG_ANSWER, LONG_ANSWER], plan, {
      '/api/thread/test/notebook': json({ id: 'calc', title: 'Calculus I' }),
      '/api/notebooks/calc': json(detail),
    });
    await renderThread('test');
    await waitFor(() => expect(document.querySelector('.nb-intro')).not.toBeNull());
    expect(screen.queryByText('Entropy')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Review Derivative with me/ }));
    await waitFor(() => expect(chats).toHaveLength(1));
    expect(lastUserText(chats[0])).toBe('Review Derivative with me');
  });

  it('its session plan names no other notebook\'s page', async () => {
    const chats = stubServer([], [LONG_ANSWER], plan, {
      '/api/thread/test/notebook': json({ id: 'calc', title: 'Calculus I' }),
      '/api/notebooks/calc': json(detail),
    });
    await renderThread('test');
    fireEvent.click(await screen.findByRole('button', { name: /Study Calculus I \(1 item\)/ }));
    await waitFor(() => expect(chats).toHaveLength(1));
    expect(lastUserText(chats[0])).toMatch(/"derivative"/);
    expect(lastUserText(chats[0])).not.toMatch(/entropy/i);
  });
});

describe('a session plan that fails to load', () => {
  it('says so instead of showing the newcomer\'s example asks', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubServer([], [], [], { '/api/session-plan': json({ error: 'boom' }, 500) });
    await renderThread();
    expect(await screen.findByText('could not load today’s session')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Teach me how derivatives work/ })).toBeNull();
  });
});

describe('"try again" for every failure the learner can see', () => {
  const photo = { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA', filename: 'graph.png' } as const;
  const asked: UIMessage = { id: 'u1', role: 'user', parts: [
    { type: 'data-command', data: { command: 'quiz' } }, photo, { type: 'text', text: 'quiz me on this graph' },
  ] };

  it('survives a reload of a failed turn, and resends its command and attachment', async () => {
    const chats = stubServer([
      asked,
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'The tutor model returned nothing for this turn.' }], metadata: { failed: true } },
    ], [LONG_ANSWER]);
    await renderThread();
    fireEvent.click(await screen.findByRole('button', { name: 'try again' }));
    await waitFor(() => expect(chats).toHaveLength(1));
    expect(chats[0].command).toBe('quiz');
    const resent = chats[0].messages.at(-1)!;
    expect(resent.role).toBe('user');
    expect(resent.parts).toContainEqual(photo);
    expect(lastUserText(chats[0])).toBe('quiz me on this graph');
  });

  it('after a refused request, re-posts the unanswered question without a second copy', async () => {
    const chats: ChatBody[] = [];
    let refused = false;
    stubServer(answered, [], [], {
      '/api/chat': () => {
        if (!refused) {
          refused = true;
          return { ok: false, status: 409, body: null, json: async () => ({ error: 'The previous turn is still shutting down.' }) };
        }
        return sseResponse(sseText(answerChunks('reply-2', LONG_ANSWER)));
      },
    });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await renderThread();
    fireEvent.click(await screen.findByRole('button', { name: 'check my understanding' }));
    expect(await screen.findByText(/still shutting down/)).not.toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'try again' }));
    await waitFor(() => expect(screen.queryByText(/still shutting down/)).toBeNull());
    for (const [url, init] of fetchMock.mock.calls) if (url === '/api/chat') chats.push(JSON.parse(String(init.body)));
    expect(chats).toHaveLength(2);
    expect(chats[1].messages).toEqual(chats[0].messages);
  });
});
