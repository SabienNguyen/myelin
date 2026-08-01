import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  createUiStream, generateMessageId, uiMessagesToChatMessages,
  type UiChunk, type UiStreamWriter,
} from '../../src/server/llm/wire.js';
import type { LoopEvent } from '../../src/server/llm/index.js';
import type { UIMessage } from '../../src/shared/uiMessages.js';

// THE wire judge: a STRICT union (unknown chunk types AND unknown fields rejected) pinning the
// chunk vocabulary the wire emits — the `UiChunk` subset of the ai@6 UI-message-stream schema,
// transcribed field-for-field from the schema the old client enforced (uiMessageChunkSchema in
// @assistant-ui/react-ai-sdk's bundled ai@6, src/ui-message-stream/ui-message-chunks.ts) before
// that dependency was removed. Both ends are first-party now, but this vocabulary stays the live
// contract until protocol v2 changes both sides in lockstep — so a chunk this union rejects is a
// wire regression, not a schema nit.
const wireChunkSchema = z.union([
  z.strictObject({ type: z.literal('start'), messageId: z.string().optional() }),
  z.strictObject({ type: z.literal('start-step') }),
  z.strictObject({ type: z.literal('finish-step') }),
  z.strictObject({
    type: z.literal('finish'),
    finishReason: z.enum(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other']).optional(),
  }),
  z.strictObject({ type: z.literal('text-start'), id: z.string() }),
  z.strictObject({ type: z.literal('text-delta'), id: z.string(), delta: z.string() }),
  z.strictObject({ type: z.literal('text-end'), id: z.string() }),
  // The ai@6 reasoning chunks, added deliberately when first-party thinking support landed —
  // same field-for-field transcription as the rest, with one documented extension both
  // first-party ends own: the wire puts FLAT keys under reasoning-end's providerMetadata
  // ({ signature }, { redactedData }) instead of ai@6's per-provider nesting.
  z.strictObject({
    type: z.literal('reasoning-start'), id: z.string(),
    providerMetadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({
    type: z.literal('reasoning-delta'), id: z.string(), delta: z.string(),
    providerMetadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({
    type: z.literal('reasoning-end'), id: z.string(),
    providerMetadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({
    type: z.literal('tool-input-start'), toolCallId: z.string(), toolName: z.string(),
    providerExecuted: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('tool-input-delta'), toolCallId: z.string(), inputTextDelta: z.string() }),
  z.strictObject({
    type: z.literal('tool-input-available'), toolCallId: z.string(), toolName: z.string(),
    input: z.unknown(), providerExecuted: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('tool-output-available'), toolCallId: z.string(), output: z.unknown(),
    providerExecuted: z.boolean().optional(), preliminary: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('tool-output-error'), toolCallId: z.string(), errorText: z.string(),
    providerExecuted: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('error'), errorText: z.string() }),
  z.strictObject({
    type: z.custom<`data-${string}`>((v) => typeof v === 'string' && v.startsWith('data-')),
    id: z.string().optional(), data: z.unknown(), transient: z.boolean().optional(),
  }),
]);

function expectValidChunks(chunks: unknown[]) {
  for (const chunk of chunks) {
    const res = wireChunkSchema.safeParse(chunk);
    expect(res.success, `wire schema rejected chunk: ${JSON.stringify(chunk)}`).toBe(true);
  }
}

async function collect(res: Response) {
  const body = await res.text();
  const lines = body.split('\n').filter((l) => l.startsWith('data: '));
  const terminated = lines[lines.length - 1] === 'data: [DONE]';
  const chunks = (terminated ? lines.slice(0, -1) : lines)
    .map((l) => JSON.parse(l.slice('data: '.length)) as Record<string, any>);
  return { body, chunks, terminated };
}

const USER_TURN: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
];

// A resubmit history: the last message is the assistant message being continued, holding an
// answered block whose grading the pre-model write patches.
const resubmitHistory = (): UIMessage[] => [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
  {
    id: 'a1', role: 'assistant',
    parts: [
      { type: 'step-start' },
      { type: 'text', state: 'done', text: "Let's warm up." },
      {
        type: 'tool-quick_check', toolCallId: 'tc1', state: 'output-available',
        input: { question: '2+2?', expected: '4' }, output: { answer: '4' },
      },
    ],
  },
];

// One model step as the loop reports it: text, then a block tool call assembled from deltas.
const scriptedRun: LoopEvent[] = [
  { type: 'step-start' },
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', text: 'Try ' },
  { type: 'text-delta', id: '0', text: 'this.' },
  { type: 'text-end', id: '0' },
  { type: 'tool-input-start', toolCallId: 'tc9', toolName: 'quick_check' },
  { type: 'tool-input-delta', toolCallId: 'tc9', delta: '{"question":' },
  { type: 'tool-input-delta', toolCallId: 'tc9', delta: '"3+3?"}' },
  { type: 'tool-call', toolCallId: 'tc9', toolName: 'quick_check', input: { question: '3+3?', mode: 'text', expected: '6', pageSlug: 'arith' } },
  {
    type: 'finish', reason: 'tool-calls',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
  { type: 'step-finish' },
];

const forwardAll = (writer: UiStreamWriter, events: LoopEvent[]) => {
  for (const ev of events) writer.forward(ev);
};

describe('createUiStream wire shape', () => {
  it('streams a full scripted run as schema-valid chunks with the pinned headers and [DONE]', async () => {
    const res = createUiStream({
      originalMessages: USER_TURN,
      execute: async (writer) => forwardAll(writer, scriptedRun),
    });

    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('connection')).toBe('keep-alive');
    expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const { chunks, terminated } = await collect(res);
    expect(terminated).toBe(true);
    expect(chunks.map((c) => c.type)).toEqual([
      'start', 'start-step',
      'text-start', 'text-delta', 'text-delta', 'text-end',
      'tool-input-start', 'tool-input-delta', 'tool-input-delta', 'tool-input-available',
      'finish-step', 'finish',
    ]);
    // The exact field names the strict client schema demands.
    expect(chunks[3]).toEqual({ type: 'text-delta', id: '0', delta: 'Try ' });
    expect(chunks[7]).toEqual({ type: 'tool-input-delta', toolCallId: 'tc9', inputTextDelta: '{"question":' });
    expect(chunks[9]).toEqual({
      type: 'tool-input-available', toolCallId: 'tc9', toolName: 'quick_check', input: { question: '3+3?', mode: 'text', expected: '6', pageSlug: 'arith' },
    });
    // The loop's per-step finish reason surfaces once, on the stream-level finish chunk.
    expect(chunks[chunks.length - 1]).toEqual({ type: 'finish', finishReason: 'tool-calls' });
    expectValidChunks(chunks);
  });

  it('mints a fresh id in the app\'s format when the last incoming message is not assistant', async () => {
    const res = createUiStream({ originalMessages: USER_TURN, execute: async () => {} });
    const { chunks } = await collect(res);
    expect(chunks[0].type).toBe('start');
    expect(chunks[0].messageId).toMatch(/^[0-9A-Za-z]{16}$/);
    expect(chunks[0].messageId).not.toBe('u1');
  });

  it('continues the incoming history\'s last assistant message id on a resubmit', async () => {
    const res = createUiStream({ originalMessages: resubmitHistory(), execute: async () => {} });
    const { chunks } = await collect(res);
    expect(chunks[0]).toEqual({ type: 'start', messageId: 'a1' });
  });

  it('merges two sequential runs into one stream: a single start/finish pair around both steps', async () => {
    // The guardrail-retry shape: session.ts runs the loop, sees no record_evidence, and runs it
    // again with a nudge — both into the SAME HTTP response.
    const secondRun: LoopEvent[] = [
      { type: 'step-start' },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', text: 'Recorded.' },
      { type: 'text-end', id: '0' },
      {
        type: 'finish', reason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      { type: 'step-finish' },
    ];
    let finalMessages: UIMessage[] = [];
    const res = createUiStream({
      originalMessages: USER_TURN,
      execute: async (writer) => {
        forwardAll(writer, scriptedRun);
        forwardAll(writer, secondRun);
      },
      onEnd: ({ messages }) => { finalMessages = messages; },
    });
    const { chunks, terminated } = await collect(res);
    expect(terminated).toBe(true);
    const types = chunks.map((c) => c.type);
    expect(types.filter((t) => t === 'start')).toHaveLength(1);
    expect(types.filter((t) => t === 'finish')).toHaveLength(1);
    expect(types[0]).toBe('start');
    expect(types[types.length - 1]).toBe('finish');
    expect(types.filter((t) => t === 'start-step')).toHaveLength(2);
    expect(types.filter((t) => t === 'finish-step')).toHaveLength(2);
    // The second run's finish reason wins on the single finish chunk.
    expect(chunks[chunks.length - 1].finishReason).toBe('stop');
    expectValidChunks(chunks);

    // Both steps assembled into ONE assistant message; the second step's text-id '0' did not
    // append onto the first step's part (finish-step resets text correlation, like the client).
    const message = finalMessages[finalMessages.length - 1];
    const texts = message.parts.filter((p) => p.type === 'text') as any[];
    expect(texts.map((t) => t.text)).toEqual(['Try this.', 'Recorded.']);
    expect(message.parts.filter((p) => p.type === 'step-start')).toHaveLength(2);
  });

  it('carries a pre-model tool-output-available write and patches the continued message', async () => {
    let finalMessages: UIMessage[] = [];
    const graded = { answer: '4', grading: { verdict: 'correct', detail: 'mechanical' } };
    const res = createUiStream({
      originalMessages: resubmitHistory(),
      execute: async (writer) => {
        writer.write({ type: 'tool-output-available', toolCallId: 'tc1', output: graded });
      },
      onEnd: ({ messages }) => { finalMessages = messages; },
    });
    const { chunks } = await collect(res);
    const chunk = chunks.find((c) => c.type === 'tool-output-available');
    expect(chunk).toEqual({ type: 'tool-output-available', toolCallId: 'tc1', output: graded });
    expectValidChunks(chunks);

    // Continuation: merged into a1, not appended as a sibling.
    expect(finalMessages).toHaveLength(2);
    const message = finalMessages[1];
    expect(message.id).toBe('a1');
    const part = message.parts.find((p) => (p as any).toolCallId === 'tc1') as any;
    expect(part.state).toBe('output-available');
    expect(part.output.grading.verdict).toBe('correct');
    // The turn-1 content is still there — merged in place, never duplicated.
    expect(message.parts.filter((p) => p.type === 'text')).toHaveLength(1);
  });

  it('excludes transient data parts from persistence while keeping non-transient ones', async () => {
    let finalMessages: UIMessage[] = [];
    const res = createUiStream({
      originalMessages: USER_TURN,
      execute: async (writer) => {
        writer.write({ type: 'data-guardrail', data: { warning: 'evidence not recorded' }, transient: true });
        writer.write({ type: 'data-note', id: 'n1', data: { x: 1 } });
        // Same id: replaces the part's data in place, exactly as the client reconciles.
        writer.write({ type: 'data-note', id: 'n1', data: { x: 2 } });
      },
      onEnd: ({ messages }) => { finalMessages = messages; },
    });
    const { chunks } = await collect(res);
    expectValidChunks(chunks);
    const parts = finalMessages[finalMessages.length - 1].parts;
    expect(parts.filter((p) => p.type === 'data-guardrail')).toHaveLength(0);
    expect(parts.filter((p) => p.type === 'data-note')).toEqual([{ type: 'data-note', id: 'n1', data: { x: 2 } }]);
  });

  it('turns an execute() throw into an error chunk on a 200 stream that still terminates', async () => {
    let ended = false;
    const res = createUiStream({
      originalMessages: USER_TURN,
      execute: async () => { throw new Error('model exploded'); },
      onError: (e) => `The tutor hit an error and this turn was lost: ${(e as Error).message}`,
      onEnd: () => { ended = true; },
    });
    expect(res.status).toBe(200);
    const { chunks, terminated } = await collect(res);
    expect(terminated).toBe(true);
    const error = chunks.find((c) => c.type === 'error');
    expect(error).toEqual({
      type: 'error',
      errorText: 'The tutor hit an error and this turn was lost: model exploded',
    });
    expect(chunks[chunks.length - 1].type).toBe('finish');
    expect(ended).toBe(true);
    expectValidChunks(chunks);
  });

  it('assembles onEnd messages the way the client\'s processor does', async () => {
    let finalMessages: UIMessage[] = [];
    const res = createUiStream({
      originalMessages: USER_TURN,
      execute: async (writer) => {
        forwardAll(writer, scriptedRun);
        // Loop-executed tool output, written by the session layer as the loop returns it.
        writer.write({ type: 'tool-output-available', toolCallId: 'tc9', output: { shown: true } });
      },
      onEnd: ({ messages }) => { finalMessages = messages; },
    });
    await collect(res);

    expect(finalMessages).toHaveLength(2);
    const message = finalMessages[1];
    expect(message.role).toBe('assistant');
    expect(message.parts[0]).toEqual({ type: 'step-start' });
    // Finished text carries state 'done' — the value the client persists.
    expect(message.parts[1]).toEqual({ type: 'text', state: 'done', text: 'Try this.' });
    // The tool part transitioned input-streaming -> input-available -> output-available in place.
    expect(message.parts[2]).toMatchObject({
      type: 'tool-quick_check', toolCallId: 'tc9', state: 'output-available',
      input: { question: '3+3?', mode: 'text', expected: '6', pageSlug: 'arith' }, output: { shown: true },
    });
    expect(message.parts).toHaveLength(3);
  });

  it('marks provider-executed tool chunks and assembles their parts', async () => {
    let finalMessages: UIMessage[] = [];
    const res = createUiStream({
      originalMessages: USER_TURN,
      execute: async (writer) => {
        writer.forward({ type: 'step-start' });
        writer.forward({ type: 'server-tool-call', toolCallId: 'ws1', toolName: 'web_search', input: { query: 'q' } });
        writer.forward({ type: 'server-tool-result', toolCallId: 'ws1', toolName: 'web_search', output: [{ url: 'https://x' }] });
        writer.forward({ type: 'step-finish' });
      },
      onEnd: ({ messages }) => { finalMessages = messages; },
    });
    const { chunks } = await collect(res);
    expect(chunks.find((c) => c.type === 'tool-input-available')).toEqual({
      type: 'tool-input-available', toolCallId: 'ws1', toolName: 'web_search',
      input: { query: 'q' }, providerExecuted: true,
    });
    expect(chunks.find((c) => c.type === 'tool-output-available')).toEqual({
      type: 'tool-output-available', toolCallId: 'ws1', output: [{ url: 'https://x' }], providerExecuted: true,
    });
    expectValidChunks(chunks);
    const part = finalMessages[1].parts.find((p) => (p as any).toolCallId === 'ws1') as any;
    expect(part).toMatchObject({ state: 'output-available', providerExecuted: true });
  });

  it('forwards loop tool-result events as output-available or output-error chunks', async () => {
    let finalMessages: UIMessage[] = [];
    const res = createUiStream({
      originalMessages: USER_TURN,
      execute: async (writer) => {
        writer.forward({ type: 'step-start' });
        writer.forward({ type: 'tool-call', toolCallId: 'ok1', toolName: 'lookup', input: {} });
        writer.forward({ type: 'tool-call', toolCallId: 'bad1', toolName: 'broken', input: {} });
        writer.forward({ type: 'tool-result', toolCallId: 'ok1', toolName: 'lookup', output: { found: true } });
        writer.forward({ type: 'tool-result', toolCallId: 'bad1', toolName: 'broken', output: 'backend down', isError: true });
        writer.forward({ type: 'step-finish' });
      },
      onEnd: ({ messages }) => { finalMessages = messages; },
    });
    const { chunks } = await collect(res);
    expect(chunks.find((c) => c.type === 'tool-output-available')).toEqual({
      type: 'tool-output-available', toolCallId: 'ok1', output: { found: true },
    });
    expect(chunks.find((c) => c.type === 'tool-output-error')).toEqual({
      type: 'tool-output-error', toolCallId: 'bad1', errorText: 'backend down',
    });
    expectValidChunks(chunks);
    const parts = finalMessages[1].parts as any[];
    expect(parts.find((p) => p.toolCallId === 'ok1')).toMatchObject({ state: 'output-available' });
    expect(parts.find((p) => p.toolCallId === 'bad1')).toMatchObject({ state: 'output-error', errorText: 'backend down' });
  });

  it('maps thinking events to schema-valid reasoning chunks and assembles the part', async () => {
    let finalMessages: UIMessage[] = [];
    const res = createUiStream({
      originalMessages: USER_TURN,
      execute: async (writer) => {
        writer.forward({ type: 'step-start' });
        writer.forward({ type: 'thinking-start', id: '0' });
        writer.forward({ type: 'thinking-delta', id: '0', text: 'Let me ' });
        writer.forward({ type: 'thinking-delta', id: '0', text: 'reason.' });
        writer.forward({ type: 'thinking-end', id: '0', text: 'Let me reason.', signature: 'sig_1' });
        writer.forward({ type: 'text-start', id: '1' });
        writer.forward({ type: 'text-delta', id: '1', text: 'Answer.' });
        writer.forward({ type: 'text-end', id: '1' });
        writer.forward({ type: 'step-finish' });
      },
      onEnd: ({ messages }) => { finalMessages = messages; },
    });
    const { chunks } = await collect(res);
    expect(chunks.filter((c) => c.type.startsWith('reasoning'))).toEqual([
      { type: 'reasoning-start', id: '0' },
      { type: 'reasoning-delta', id: '0', delta: 'Let me ' },
      { type: 'reasoning-delta', id: '0', delta: 'reason.' },
      // The assembled text stays off the wire (the reducer accumulated the deltas); only the
      // echo plumbing rides providerMetadata.
      { type: 'reasoning-end', id: '0', providerMetadata: { signature: 'sig_1' } },
    ]);
    expectValidChunks(chunks);
    const parts = finalMessages[1].parts;
    expect(parts[1]).toEqual({
      type: 'reasoning', state: 'done', text: 'Let me reason.', providerMetadata: { signature: 'sig_1' },
    });
    expect(parts[2]).toEqual({ type: 'text', state: 'done', text: 'Answer.' });
  });

  it('carries a redacted block as an empty-text reasoning part with redactedData metadata', async () => {
    let finalMessages: UIMessage[] = [];
    const res = createUiStream({
      originalMessages: USER_TURN,
      execute: async (writer) => {
        writer.forward({ type: 'step-start' });
        writer.forward({ type: 'thinking-start', id: '0' });
        writer.forward({ type: 'thinking-end', id: '0', text: '', redacted: { data: 'opaque==' } });
        writer.forward({ type: 'step-finish' });
      },
      onEnd: ({ messages }) => { finalMessages = messages; },
    });
    const { chunks } = await collect(res);
    expect(chunks.find((c) => c.type === 'reasoning-end')).toEqual({
      type: 'reasoning-end', id: '0', providerMetadata: { redactedData: 'opaque==' },
    });
    expectValidChunks(chunks);
    expect(finalMessages[1].parts[1]).toEqual({
      type: 'reasoning', state: 'done', text: '', providerMetadata: { redactedData: 'opaque==' },
    });
  });

  it('generateMessageId matches the SDK default format', () => {
    for (let i = 0; i < 20; i++) expect(generateMessageId()).toMatch(/^[0-9A-Za-z]{16}$/);
  });
});

describe('uiMessagesToChatMessages', () => {
  it('round-trips a block-tool turn: text, assistant tool-call, client-supplied tool-result', () => {
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
      {
        id: 'a1', role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'text', state: 'done', text: "Let's warm up." },
          {
            type: 'tool-quick_check', toolCallId: 'tc1', state: 'output-available',
            input: { question: '2+2?', mode: 'text', expected: '4', pageSlug: 'arith' }, output: { answer: '4' },
          },
        ],
      },
    ];
    expect(uiMessagesToChatMessages(messages)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'quiz me' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: "Let's warm up." },
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'quick_check', input: { question: '2+2?', mode: 'text', expected: '4', pageSlug: 'arith' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'quick_check', output: { answer: '4' } }],
      },
    ]);
  });

  it('converts user file parts from their data: URLs — mediaType from the prefix, bare base64 payload', () => {
    const messages: UIMessage[] = [{
      id: 'u1', role: 'user',
      parts: [
        { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,aW1n', filename: 'shot.png' },
        { type: 'file', mediaType: 'application/pdf', url: 'data:application/pdf;base64,cGRm' },
        { type: 'text', text: 'see attached' },
      ],
    }];
    expect(uiMessagesToChatMessages(messages)).toEqual([{
      role: 'user',
      content: [
        { type: 'file', mediaType: 'image/png', data: 'aW1n', filename: 'shot.png' },
        { type: 'file', mediaType: 'application/pdf', data: 'cGRm' },
        { type: 'text', text: 'see attached' },
      ],
    }]);
  });

  it('skips a file part whose URL is not a well-formed base64 data: URL — history must not kill a turn', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const messages: UIMessage[] = [{
        id: 'u1', role: 'user',
        parts: [
          { type: 'file', mediaType: 'image/png', url: 'https://example.com/x.png', filename: 'x.png' },
          { type: 'file', mediaType: 'image/png', url: 'data:image/png,not-base64-framed' },
          { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,b2s=', filename: 'ok.png' },
          { type: 'text', text: 'hi' },
        ],
      }];
      // The two malformed parts vanish (each logged); the good file and the text survive.
      expect(uiMessagesToChatMessages(messages)).toEqual([{
        role: 'user',
        content: [
          { type: 'file', mediaType: 'image/png', data: 'b2s=', filename: 'ok.png' },
          { type: 'text', text: 'hi' },
        ],
      }]);
      expect(errors).toHaveBeenCalledTimes(2);
    } finally {
      errors.mockRestore();
    }
  });

  it('groups a multi-step assistant message so each step\'s calls pair with THEIR results', () => {
    const messages: UIMessage[] = [
      {
        id: 'a1', role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-search', toolCallId: 's1', state: 'output-available',
            input: { query: 'derivatives' }, output: { hits: [] },
          },
          { type: 'step-start' },
          { type: 'text', state: 'done', text: 'Nothing found.' },
          {
            type: 'tool-record_evidence', toolCallId: 'r1', state: 'output-available',
            input: { slug: 'arith' }, output: { ok: true },
          },
          { type: 'step-start' },
          { type: 'text', state: 'done', text: 'Done.' },
        ],
      },
    ];
    expect(uiMessagesToChatMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 's1', toolName: 'search', input: { query: 'derivatives' } }],
      },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 's1', toolName: 'search', output: { hits: [] } }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Nothing found.' },
          { type: 'tool-call', toolCallId: 'r1', toolName: 'record_evidence', input: { slug: 'arith' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'r1', toolName: 'record_evidence', output: { ok: true } }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ]);
  });

  it('keeps a paused block tool\'s call without a result — the resubmit supplies it', () => {
    const messages: UIMessage[] = [
      {
        id: 'a1', role: 'assistant',
        parts: [{
          type: 'tool-quick_check', toolCallId: 'tc1', state: 'input-available',
          input: { question: '2+2?', mode: 'text', expected: '4', pageSlug: 'arith' },
        }],
      },
    ];
    expect(uiMessagesToChatMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'quick_check', input: { question: '2+2?', mode: 'text', expected: '4', pageSlug: 'arith' } }],
      },
    ]);
  });

  it('turns output-error parts into isError tool-results carrying the errorText', () => {
    const messages: UIMessage[] = [
      {
        id: 'a1', role: 'assistant',
        parts: [{
          type: 'tool-search', toolCallId: 's1', state: 'output-error',
          input: { query: 'x' }, errorText: 'backend down',
        }],
      },
    ];
    expect(uiMessagesToChatMessages(messages)).toEqual([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 's1', toolName: 'search', input: { query: 'x' } }] },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 's1', toolName: 'search', output: 'backend down', isError: true }],
      },
    ]);
  });

  it('skips data parts, step-start markers, never-completed calls, and provider-executed tools', () => {
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }, { type: 'data-note', data: { x: 1 } }] },
      {
        id: 'a1', role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'data-guardrail', data: { warning: 'w' } },
          { type: 'tool-quick_check', toolCallId: 'p1', state: 'input-streaming' },
          {
            type: 'tool-web_search', toolCallId: 'ws1', state: 'output-available',
            providerExecuted: true, input: { query: 'q' }, output: [],
          },
          { type: 'text', state: 'done', text: 'Answer.' },
        ],
      },
    ];
    expect(uiMessagesToChatMessages(messages)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Answer.' }] },
    ]);
  });

  it('round-trips a reasoning part into a ThinkingPart inside its own step block', () => {
    // The block-pause resubmit shape when thinking is active: the paused assistant message holds
    // thinking, text, and the tool call. The thinking part must come back FIRST in the same
    // assistant ChatMessage as the call — the Anthropic wire rejects the echoed tool_use without
    // its preceding thinking block.
    const messages: UIMessage[] = [
      {
        id: 'a1', role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'reasoning', state: 'done', text: 'Warm-up first.',
            providerMetadata: { signature: 'sig_1' },
          },
          { type: 'text', state: 'done', text: 'Try this.' },
          {
            type: 'tool-quick_check', toolCallId: 'tc1', state: 'output-available',
            input: { question: '2+2?', mode: 'text', expected: '4', pageSlug: 'arith' }, output: { answer: '4' },
          },
          { type: 'step-start' },
          { type: 'reasoning', state: 'done', text: '', providerMetadata: { redactedData: 'opaque==' } },
          { type: 'text', state: 'done', text: 'Done.' },
        ],
      },
    ];
    expect(uiMessagesToChatMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'Warm-up first.', signature: 'sig_1' },
          { type: 'text', text: 'Try this.' },
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'quick_check', input: { question: '2+2?', mode: 'text', expected: '4', pageSlug: 'arith' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'quick_check', output: { answer: '4' } }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: '', redacted: { data: 'opaque==' } },
          { type: 'text', text: 'Done.' },
        ],
      },
    ]);
  });

  it('throws on a system message — the system prompt rides ChatRequest.system', () => {
    expect(() => uiMessagesToChatMessages([
      { id: 's1', role: 'system', parts: [{ type: 'text', text: 'be terse' }] },
    ])).toThrow(/ChatRequest.system/);
  });

  it('round-trips what the wire assembled: stream -> onEnd messages -> ChatMessage transcript', async () => {
    let finalMessages: UIMessage[] = [];
    const res = createUiStream({
      originalMessages: USER_TURN,
      execute: async (writer) => forwardAll(writer, scriptedRun),
      onEnd: ({ messages }) => { finalMessages = messages; },
    });
    await collect(res);
    // The assembled turn ends on a paused block tool (input-available); the next request —
    // after the client supplies the output — is exactly the resubmit shape tested above.
    expect(uiMessagesToChatMessages(finalMessages)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'quiz me' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Try this.' },
          { type: 'tool-call', toolCallId: 'tc9', toolName: 'quick_check', input: { question: '3+3?', mode: 'text', expected: '6', pageSlug: 'arith' } },
        ],
      },
    ]);
  });
});

describe('thinking round trip: stream -> onEnd messages -> ChatMessage transcript', () => {
  it('echoes the signature-bearing thinking part ahead of the paused tool call', async () => {
    const run: LoopEvent[] = [
      { type: 'step-start' },
      { type: 'thinking-start', id: '0' },
      { type: 'thinking-delta', id: '0', text: 'Quiz them.' },
      { type: 'thinking-end', id: '0', text: 'Quiz them.', signature: 'sig_9' },
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', text: 'Try this.' },
      { type: 'text-end', id: '1' },
      { type: 'tool-input-start', toolCallId: 'tc9', toolName: 'quick_check' },
      { type: 'tool-call', toolCallId: 'tc9', toolName: 'quick_check', input: { question: '3+3?', mode: 'text', expected: '6', pageSlug: 'arith' } },
      {
        type: 'finish', reason: 'tool-calls',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      { type: 'step-finish' },
    ];
    let finalMessages: UIMessage[] = [];
    const res = createUiStream({
      originalMessages: USER_TURN,
      execute: async (writer) => forwardAll(writer, run),
      onEnd: ({ messages }) => { finalMessages = messages; },
    });
    await collect(res);
    // The next request after the client answers the block is built from exactly these messages;
    // the thinking block riding first is what keeps the Anthropic wire from 400ing the resubmit.
    expect(uiMessagesToChatMessages(finalMessages)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'quiz me' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'Quiz them.', signature: 'sig_9' },
          { type: 'text', text: 'Try this.' },
          { type: 'tool-call', toolCallId: 'tc9', toolName: 'quick_check', input: { question: '3+3?', mode: 'text', expected: '6', pageSlug: 'arith' } },
        ],
      },
    ]);
  });
});

// UiChunk is compile-time verified against the strict schema by the runtime validations above;
// this just pins that the type allows the two app-written chunk shapes session.ts needs.
const _premodel: UiChunk = { type: 'tool-output-available', toolCallId: 'x', output: {} };
const _guardrail: UiChunk = { type: 'data-guardrail', data: { warning: 'w' }, transient: true };
void _premodel; void _guardrail;


describe('malformed block args become an error card, not a crash', () => {
  const run = async (toolName: string, input: unknown) => {
    const res = createUiStream({
      originalMessages: [],
      execute: async (writer) => {
        writer.forward({ type: 'tool-call', toolCallId: 'b1', toolName, input } as any);
      },
    });
    return (await collect(res)).chunks;
  };

  it('flags a speak block with no language tag', async () => {
    const chunks = await run('speak', { text: 'xin chao' });
    expect(chunks.find((c) => c.type === 'tool-input-available' && c.toolCallId === 'b1'),
      'the part must still be created — the assembler cannot attach output to a part it lacks').toBeTruthy();
    const err = chunks.find((c) => c.type === 'tool-output-error' && c.toolCallId === 'b1');
    expect(err).toBeTruthy();
    expect(String(err?.errorText)).toMatch(/lang/i);
  });

  it('leaves a valid block completely alone', async () => {
    const chunks = await run('quick_check',
      { question: '2+2?', mode: 'choice', choices: ['3', '4'], expected: '4', pageSlug: 'arith' });
    expect(chunks.find((c) => c.type === 'tool-input-available' && c.toolCallId === 'b1')).toBeTruthy();
    expect(chunks.find((c) => c.type === 'tool-output-error')).toBeFalsy();
  });

  it('does not police non-block tools', async () => {
    const chunks = await run('search', {});
    expect(chunks.find((c) => c.type === 'tool-output-error')).toBeFalsy();
  });
});
