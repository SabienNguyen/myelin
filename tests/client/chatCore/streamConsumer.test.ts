// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { consumeChatStream } from '../../../src/client/chatCore/streamConsumer.js';
import type { UIMessage } from '../../../src/shared/uiMessages.js';
import { hangingResponse, scriptedTurnChunks, sseResponse, sseText } from './sse.js';

const USER_TURN: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
];

const consume = (
  fetchImpl: typeof fetch,
  { messages = USER_TURN, signal = new AbortController().signal }: { messages?: UIMessage[]; signal?: AbortSignal } = {},
) => {
  const updates: UIMessage[][] = [];
  const onFinish = vi.fn();
  const onError = vi.fn();
  const result = consumeChatStream({
    body: { messages, mode: 'learn', threadId: 't1', writeUp: false },
    signal,
    onUpdate: (m) => updates.push(m),
    onFinish,
    onError,
    fetchImpl,
  });
  return { result, updates, onFinish, onError };
};

describe('consumeChatStream', () => {
  it('POSTs the exact body the server reads and assembles the recorded stream', async () => {
    let recorded: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      recorded = { url: String(input), init: init! };
      return sseResponse(sseText(scriptedTurnChunks()));
    }) as typeof fetch;

    const { result, updates, onFinish, onError } = consume(fetchImpl);
    expect(await result).toBe('done');

    expect(recorded!.url).toBe('/api/chat');
    expect(recorded!.init.method).toBe('POST');
    expect(JSON.parse(recorded!.init.body as string)).toEqual({
      messages: USER_TURN, mode: 'learn', threadId: 't1', writeUp: false,
    });

    expect(onError).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledTimes(1);
    const final = onFinish.mock.calls[0]![0] as UIMessage[];
    expect(final).toHaveLength(2);
    expect(final[1]).toMatchObject({
      id: 'A1B2C3D4E5F6G7H8',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'text', state: 'done', text: 'Try this.' },
        { type: 'tool-quick_check', toolCallId: 'tc9', state: 'input-available', input: { question: '3+3?' } },
      ],
    });

    // Progressive rendering: the text grew across updates, it did not appear all at once.
    const texts = updates.map((m) => {
      const part = m[m.length - 1]!.parts.find((p) => p.type === 'text') as { text: string } | undefined;
      return part?.text;
    });
    expect(texts).toContain('Try ');
    expect(texts).toContain('Try this.');
  });

  it('gives every update a fresh last-message identity (assistant-ui converts per reference)', async () => {
    const { result, updates } = consume(async () => sseResponse(sseText(scriptedTurnChunks())));
    await result;
    const lasts = updates.map((m) => m[m.length - 1]);
    for (let i = 1; i < lasts.length; i++) expect(lasts[i]).not.toBe(lasts[i - 1]);
  });

  it('surfaces an error chunk AND still finishes — the server terminates errored turns cleanly', async () => {
    const chunks = [
      { type: 'start', messageId: 'm1' },
      { type: 'error', errorText: 'The tutor hit an error and this turn was lost: model exploded' },
      { type: 'finish' },
    ];
    const { result, onFinish, onError } = consume(async () => sseResponse(sseText(chunks)));
    await result;
    expect(onError).toHaveBeenCalledWith('The tutor hit an error and this turn was lost: model exploded');
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('treats a stream that ends without [DONE] as a dropped connection: error, no finish', async () => {
    const chunks = [{ type: 'start', messageId: 'm1' }, { type: 'text-start', id: '0' }];
    const { result, onFinish, onError } = consume(async () => sseResponse(sseText(chunks, { done: false })));
    expect(await result).toBe('done');
    expect(onFinish).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('The connection to the tutor dropped mid-turn.');
  });

  it('reports an HTTP failure without a method or path in the learner-facing text', async () => {
    const { result, onFinish, onError } = consume(async () => ({ ok: false, status: 502, body: null } as unknown as Response));
    await result;
    expect(onFinish).not.toHaveBeenCalled();
    const text = onError.mock.calls[0]![0] as string;
    expect(text).toMatch(/502/);
    expect(text).not.toMatch(/\/api\//);
    expect(text).not.toMatch(/\bPOST\b/);
  });

  it('returns aborted with no callbacks once the signal fires mid-stream', async () => {
    const controller = new AbortController();
    const { result, onFinish, onError, updates } = consume(
      (async (_input: RequestInfo | URL, init?: RequestInit) => hangingResponse(init!.signal!)) as typeof fetch,
      { signal: controller.signal },
    );
    controller.abort();
    expect(await result).toBe('aborted');
    expect(updates).toHaveLength(0);
    expect(onFinish).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
