// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChatStore, type ChatStoreOptions } from '../../../src/client/chatCore/chatStore.js';
import type { ToolUIPart, UIMessage } from '../../../src/shared/uiMessages.js';
import {
  continuationChunks, fakeFetch, scriptedTurnChunks, sseResponse, sseText, type RecordedCall,
} from './sse.js';

afterEach(() => { vi.restoreAllMocks(); });

/** Turn-1 aftermath: the tutor asked a quick_check and the stream ended with it paused. */
const pausedBlockHistory = (): UIMessage[] => [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
  {
    id: 'a1', role: 'assistant',
    parts: [
      { type: 'step-start' },
      { type: 'text', state: 'done', text: "Let's warm up." },
      { type: 'tool-quick_check', toolCallId: 'tc1', state: 'input-available', input: { question: '2+2?' } },
    ],
  },
];

const makeStore = (
  streams: Array<unknown[] | 'hang'>,
  initialMessages: UIMessage[],
  over: Partial<ChatStoreOptions> = {},
) => {
  const fetched = fakeFetch(streams);
  const store = new ChatStore({
    threadId: 't1',
    initialMessages,
    requestContext: () => ({ mode: 'learn', writeUp: false }),
    fetchImpl: fetched.impl,
    ...over,
  });
  return { store, ...fetched };
};

const settled = (store: ChatStore) =>
  vi.waitFor(() => { expect(store.getState().isRunning).toBe(false); });

// Absence proof: a queued resubmit would start within these macrotasks.
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('ChatStore', () => {
  it('sendMessage appends the user turn, streams the response, and persists via PUT', async () => {
    const { store, calls, chatCalls } = makeStore([scriptedTurnChunks()], []);
    const seen: boolean[] = [];
    store.subscribe(() => seen.push(store.getState().isRunning));

    store.sendMessage('quiz me');
    expect(store.getState().isRunning).toBe(true);
    await settled(store);

    expect(chatCalls()).toHaveLength(1);
    const body = chatCalls()[0]!.body as { messages: UIMessage[]; mode: string; threadId: string; writeUp: boolean };
    expect(body.mode).toBe('learn');
    expect(body.threadId).toBe('t1');
    expect(body.writeUp).toBe(false);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'quiz me' }] });
    expect(body.messages[0]!.id).toMatch(/^[0-9A-Za-z]{16}$/);

    const { messages, error } = store.getState();
    expect(error).toBeUndefined();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'text', state: 'done', text: 'Try this.' },
        { type: 'tool-quick_check', toolCallId: 'tc9', state: 'input-available' },
      ],
    });

    // Mid-stream subscribers saw the run in flight — the working indicator's whole basis.
    expect(seen).toContain(true);

    const put = calls.find((c) => c.url === '/api/thread/t1');
    expect(put?.init.method).toBe('PUT');
    expect(put?.body).toEqual(store.getState().messages);
  });

  it('reads requestContext per request, so a mid-thread mode switch and one-shot writeUp reach the wire', async () => {
    let mode = 'learn';
    let writeUp = false;
    const { store, chatCalls } = makeStore(
      [scriptedTurnChunks('M1M1M1M1M1M1M1M1'), scriptedTurnChunks('M2M2M2M2M2M2M2M2')], [],
      { requestContext: () => ({ mode, writeUp }) },
    );
    store.sendMessage('one');
    await settled(store);
    mode = 'freeform';
    writeUp = true;
    store.sendMessage('two');
    await settled(store);

    expect(chatCalls().map((c) => (c.body as { mode: string }).mode)).toEqual(['learn', 'freeform']);
    expect(chatCalls().map((c) => (c.body as { writeUp: boolean }).writeUp)).toEqual([false, true]);
  });

  it('addToolOutput on a block part patches it and fires EXACTLY one resubmit', async () => {
    const { store, calls, chatCalls } = makeStore([continuationChunks('a1', 'tc1')], pausedBlockHistory());

    store.addToolOutput({ toolCallId: 'tc1', output: { answer: '4' } });
    await settled(store);
    await flush();

    // One POST, carrying the history as-is with the learner's answer patched in.
    expect(chatCalls()).toHaveLength(1);
    const sent = (chatCalls()[0]!.body as { messages: UIMessage[] }).messages;
    expect(sent[1]!.parts[2]).toMatchObject({ toolCallId: 'tc1', state: 'output-available', output: { answer: '4' } });

    // The continuation merged into a1 (id continuity) and its MCP + text step did NOT re-trigger.
    const { messages } = store.getState();
    expect(messages).toHaveLength(2);
    expect(messages[1]!.id).toBe('a1');
    const parts = messages[1]!.parts;
    expect(parts.find((p) => (p as ToolUIPart).toolCallId === 'tc1')).toMatchObject({
      state: 'output-available', output: { grading: { verdict: 'correct', detail: 'mechanical' } },
    });
    expect(parts.find((p) => (p as ToolUIPart).toolCallId === 'r1')).toMatchObject({ state: 'output-available' });
    expect(calls.filter((c) => c.url === '/api/thread/t1')).toHaveLength(1);
  });

  it('a block answered while its stream is STILL RUNNING keeps the answer and resubmits once the stream settles', async () => {
    // The paced-stream race a fast mock never hits: every stream snapshot comes from the
    // assembler, which knows nothing of client-added outputs — a click landing mid-stream must
    // not be undone by the next chunk, and the finish-time predicate must still see it.
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const gatedBody = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const feed = (chunks: unknown[]) => {
      for (const c of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
    };
    const turn1 = scriptedTurnChunks();

    // Hand-rolled fetch: /api/chat #1 streams the GATED body so the test can interleave the
    // answer between chunks; #2 serves the recorded continuation; everything else 200s.
    const calls: RecordedCall[] = [];
    const chatCalls = () => calls.filter((c) => c.url === '/api/chat');
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init!, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url !== '/api/chat') return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      if (chatCalls().length === 1) return { ok: true, status: 200, body: gatedBody } as unknown as Response;
      return sseResponse(sseText(continuationChunks('A1B2C3D4E5F6G7H8', 'tc9')));
    }) as typeof fetch;
    const store = new ChatStore({
      threadId: 't1', initialMessages: [],
      requestContext: () => ({ mode: 'learn', writeUp: false }),
      fetchImpl,
    });

    store.sendMessage('quiz me');
    feed(turn1.slice(0, -2)); // up to tool-input-available: block present, stream still open
    await vi.waitFor(() => {
      expect(store.getState().messages[1]?.parts.some(
        (p) => (p as ToolUIPart).toolCallId === 'tc9' && (p as ToolUIPart).state === 'input-available',
      )).toBe(true);
    });
    expect(store.getState().isRunning).toBe(true);
    store.addToolOutput({ toolCallId: 'tc9', output: { answer: '6' } });

    feed(turn1.slice(-2)); // finish-step + finish arrive AFTER the answer
    await vi.waitFor(() => {
      // The later snapshots did not undo the answer.
      expect(store.getState().messages[1]!.parts.find(
        (p) => (p as ToolUIPart).toolCallId === 'tc9',
      )).toMatchObject({ state: 'output-available' });
    });
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
    await settled(store);
    await flush();

    // Exactly one resubmit, carrying the mid-stream answer; the continuation graded it.
    expect(chatCalls()).toHaveLength(2);
    const sent = (chatCalls()[1]!.body as { messages: UIMessage[] }).messages;
    expect(sent[1]!.parts.find((p) => (p as ToolUIPart).toolCallId === 'tc9'))
      .toMatchObject({ state: 'output-available', output: { answer: '6' } });
    expect(store.getState().messages[1]!.parts.find((p) => (p as ToolUIPart).toolCallId === 'tc9'))
      .toMatchObject({ output: { grading: { verdict: 'correct', detail: 'mechanical' } } });
  });

  it('does NOT resubmit for a non-block tool output', async () => {
    const history: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'open it' }] },
      {
        id: 'a1', role: 'assistant',
        parts: [{ type: 'tool-open_source', toolCallId: 'os1', state: 'input-available', input: { slug: 's' } }],
      },
    ];
    const { store, chatCalls } = makeStore([], history);
    store.addToolOutput({ toolCallId: 'os1', output: { opened: true } });
    await flush();

    expect(chatCalls()).toHaveLength(0);
    expect(store.getState().messages[1]!.parts[0]).toMatchObject({ state: 'output-available', output: { opened: true } });
  });

  it('logs and ignores a result for an unknown toolCallId instead of corrupting state', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, chatCalls } = makeStore([], pausedBlockHistory());
    const before = store.getState().messages;
    store.addToolOutput({ toolCallId: 'nope', output: {} });
    await flush();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('nope'));
    expect(store.getState().messages).toBe(before);
    expect(chatCalls()).toHaveLength(0);
  });

  it('closes a block the learner typed past as output-error, so the transcript never carries a resultless call', async () => {
    const { store, chatCalls } = makeStore([scriptedTurnChunks()], pausedBlockHistory());
    store.sendMessage('actually, explain it differently');
    await settled(store);

    const sent = (chatCalls()[0]!.body as { messages: UIMessage[] }).messages;
    expect(sent[1]!.parts[2]).toMatchObject({
      toolCallId: 'tc1',
      state: 'output-error',
      errorText: 'User cancelled tool call by sending a new message.',
    });
    expect(sent[2]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'actually, explain it differently' }] });
  });

  it('aborts a superseded send; the newer run owns the state', async () => {
    const { store, chatCalls } = makeStore(['hang', scriptedTurnChunks()], []);
    store.sendMessage('one');
    store.sendMessage('two');
    await settled(store);

    expect(chatCalls()).toHaveLength(2);
    expect(chatCalls()[0]!.init.signal!.aborted).toBe(true);
    const sent = (chatCalls()[1]!.body as { messages: UIMessage[] }).messages;
    expect(sent.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['one', 'two']);
    expect(store.getState().error).toBeUndefined();
    expect(store.getState().messages).toHaveLength(3);
  });

  it('an error chunk lands in state.error, the turn still settles, and no resubmit follows', async () => {
    const errored = [
      { type: 'start', messageId: 'E1E1E1E1E1E1E1E1' },
      { type: 'error', errorText: 'The tutor hit an error and this turn was lost: model exploded' },
      { type: 'finish' },
    ];
    const { store, chatCalls } = makeStore([errored], []);
    store.sendMessage('hi');
    await settled(store);
    await flush();

    expect(store.getState().error).toMatch(/model exploded/);
    expect(chatCalls()).toHaveLength(1);
  });

  it('setMessages replaces the history (thread restore) and resubmit posts it as-is', async () => {
    const { store, chatCalls } = makeStore([continuationChunks('a1', 'tc1')], []);
    const restored = pausedBlockHistory();
    restored[1]!.parts[2] = { ...(restored[1]!.parts[2] as ToolUIPart), state: 'output-available', output: { answer: '4' } };
    store.setMessages(restored);
    store.resubmit();
    await settled(store);

    expect((chatCalls()[0]!.body as { messages: UIMessage[] }).messages).toEqual(restored);
  });
});
