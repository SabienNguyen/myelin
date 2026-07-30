// Recorded-stream fixtures for the chatCore tests: the same scripted chunk sequences
// tests/llm/wire.test.ts proves the server emits, replayed as SSE bytes through a fake fetch.

/** The wire output of wire.test.ts's `scriptedRun`: one model step — text, then a block tool
 * call assembled from deltas, left paused at input-available. */
export const scriptedTurnChunks = (messageId = 'A1B2C3D4E5F6G7H8'): unknown[] => [
  { type: 'start', messageId },
  { type: 'start-step' },
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: 'Try ' },
  { type: 'text-delta', id: '0', delta: 'this.' },
  { type: 'text-end', id: '0' },
  { type: 'tool-input-start', toolCallId: 'tc9', toolName: 'quick_check' },
  { type: 'tool-input-delta', toolCallId: 'tc9', inputTextDelta: '{"question":' },
  { type: 'tool-input-delta', toolCallId: 'tc9', inputTextDelta: '"3+3?"}' },
  { type: 'tool-input-available', toolCallId: 'tc9', toolName: 'quick_check', input: { question: '3+3?' } },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'tool-calls' },
];

/** The resubmit continuation: the server patches grading into the answered block (pre-model
 * write), then the follow-up step records evidence and replies — no new block parts, so the
 * auto-resubmit predicate must NOT fire again on this turn's result. */
export const continuationChunks = (messageId: string, answeredToolCallId: string): unknown[] => [
  { type: 'start', messageId },
  {
    type: 'tool-output-available', toolCallId: answeredToolCallId,
    output: { answer: '4', grading: { verdict: 'correct', detail: 'mechanical' } },
  },
  { type: 'start-step' },
  { type: 'tool-input-available', toolCallId: 'r1', toolName: 'record_evidence', input: { slug: 'arith' } },
  { type: 'tool-output-available', toolCallId: 'r1', output: { ok: true } },
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: 'Correct!' },
  { type: 'text-end', id: '0' },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'stop' },
];

export const sseText = (chunks: unknown[], { done = true }: { done?: boolean } = {}): string =>
  [...chunks.map((c) => `data: ${JSON.stringify(c)}`), ...(done ? ['data: [DONE]'] : []), '']
    .join('\n\n');

/** SSE bytes as a streaming Response, deliberately enqueued in small frames so the consumer's
 * line buffering across network-chunk boundaries is exercised, not just the whole-body case. */
export const sseResponse = (text: string, frameSize = 7): Response => {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += frameSize) controller.enqueue(bytes.slice(i, i + frameSize));
        controller.close();
      },
    }),
  } as unknown as Response;
};

/** A response whose body never yields until the request's signal aborts — the shape a real fetch
 * takes when a superseding send cancels the stream mid-read. */
export const hangingResponse = (signal: AbortSignal): Response => ({
  ok: true,
  status: 200,
  body: {
    getReader: () => ({
      read: () => signal.aborted
        ? Promise.reject(new DOMException('aborted', 'AbortError'))
        : new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    }),
  },
} as unknown as Response);

export interface RecordedCall {
  url: string;
  init: RequestInit;
  body: unknown;
}

/** A fetch fake serving /api/chat from scripted streams (one per POST, in order) and answering
 * everything else (the thread PUT) with 200 — every call recorded with its parsed body. */
export function fakeFetch(streams: Array<unknown[] | 'hang'>) {
  const calls: RecordedCall[] = [];
  const chatCalls = () => calls.filter((c) => c.url === '/api/chat');
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init!, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url !== '/api/chat') return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    const stream = streams[chatCalls().length - 1];
    if (stream === undefined) throw new Error(`unscripted /api/chat call #${chatCalls().length}`);
    if (stream === 'hang') return hangingResponse(init!.signal!);
    return sseResponse(sseText(stream));
  }) as typeof fetch;
  return { calls, chatCalls, impl };
}
