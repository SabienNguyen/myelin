import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { anthropicModel, LlmHttpError, type StreamEvent } from '../../src/server/llm/index.js';

// Same pattern as webtools.test.ts: a fake Anthropic endpoint capturing what actually leaves
// the process, since request shaping is exactly the part reading the adapter cannot verify.
let server: Server;
let base: string;
let captured: { url: string; headers: IncomingHttpHeaders; body: any }[] = [];
let respond: (res: ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(body) });
      respond(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { captured = []; });

const json = (status: number, obj: unknown) => (res: ServerResponse) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
};

// Writes the SSE payload in the exact network chunks given, with a pause between writes so each
// arrives as a separate read on the client side.
const sse = (chunks: string[]) => (res: ServerResponse) => {
  res.setHeader('content-type', 'text/event-stream');
  void (async () => {
    for (const c of chunks) {
      res.write(c);
      await new Promise((r) => setTimeout(r, 5));
    }
    res.end();
  })();
};

const okText = json(200, {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
});

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of iter) events.push(ev);
  return events;
}

// Zero-delay retries: the taxonomy tests below assert errors that now surface only after the
// adapter's retry budget (retry.ts) is spent, and the real 2s/4s backoff would time tests out.
const model = () => anthropicModel({ modelId: 'claude-x', apiKey: 'k', baseUrl: base, retry: { delayMs: () => 0 } });
const USER_Q = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'q' }] }];

describe('anthropic request shaping', () => {
  it('sends the Messages API shape: headers, system array, tools, forced tool_choice', async () => {
    respond = okText;
    await model().generate({
      system: 'sys',
      messages: USER_Q,
      tools: [
        { name: 'lookup', description: 'd', inputSchema: { type: 'object' } },
        { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
      ],
      toolChoice: { name: 'lookup' },
    });
    const sent = captured[0];
    expect(sent.url).toBe('/v1/messages');
    expect(sent.headers['x-api-key']).toBe('k');
    expect(sent.headers['anthropic-version']).toBe('2023-06-01');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.body.model).toBe('claude-x');
    expect(sent.body.max_tokens).toBe(4096); // wire requires it; harness default when unset
    expect(sent.body.stream).toBe(false);
    expect(sent.body.system).toEqual([{ type: 'text', text: 'sys' }]);
    expect(sent.body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'q' }] }]);
    expect(sent.body.tools).toEqual([
      { name: 'lookup', description: 'd', input_schema: { type: 'object' } },
      // The server tool travels verbatim — this exact object is what webTools will hand over.
      { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
    ]);
    expect(sent.body.tool_choice).toEqual({ type: 'tool', name: 'lookup' });
  });

  it('resolves ANTHROPIC_API_KEY per request, so a key saved after construction takes effect', async () => {
    respond = okText;
    const m = anthropicModel({ modelId: 'claude-x', baseUrl: base });
    process.env.ANTHROPIC_API_KEY = 'late-key';
    try {
      await m.generate({ messages: USER_Q });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    expect(captured[0].headers['x-api-key']).toBe('late-key');
  });

  it('cache: true places the four breakpoints — tools tail, system, penultimate and last message tails', async () => {
    respond = okText;
    await model().generate({
      system: 'sys',
      cache: true,
      tools: [
        { name: 'first', description: 'd', inputSchema: { type: 'object' } },
        { name: 'last', description: 'd', inputSchema: { type: 'object' } },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
        // Penultimate breakpoint: the block-resubmit shape patches grading INTO the last
        // assistant message between requests, so the last-message entry misses — this one,
        // written by the previous request, still saves the whole prefix.
        { role: 'assistant', content: [{ type: 'text', text: 'b1' }, { type: 'text', text: 'b2' }] },
        { role: 'user', content: [{ type: 'text', text: 'c1' }, { type: 'text', text: 'c2' }] },
      ],
    });
    const body = captured[0].body;
    expect(body.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    const marked = body.messages
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.cache_control)
      .map((b: any) => b.text);
    expect(marked).toEqual(['b2', 'c2']); // tail block of the penultimate and last messages only
  });

  it('a single-message history takes one history breakpoint, not a phantom penultimate', async () => {
    respond = okText;
    await model().generate({ system: 'sys', cache: true, messages: USER_Q });
    const marked = captured[0].body.messages.flatMap((m: any) => m.content).filter((b: any) => b.cache_control);
    expect(marked).toHaveLength(1);
  });

  it("cacheTtl: '1h' rides every breakpoint; absent means the bare 5m default object", async () => {
    respond = okText;
    await model().generate({
      system: 'sys', cache: true, cacheTtl: '1h',
      tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
      messages: USER_Q,
    });
    const body = captured[0].body;
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const marked = body.messages.flatMap((m: any) => m.content).filter((b: any) => b.cache_control);
    expect(marked[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    // ttl is opt-in: no cacheTtl → no ttl key anywhere (the wire's 5m default).
    respond = okText;
    await model().generate({ system: 'sys', cache: true, messages: USER_Q });
    expect(JSON.stringify(captured[1].body)).not.toContain('ttl');
  });

  it('places no cache_control anywhere without cache: true', async () => {
    respond = okText;
    await model().generate({
      system: 'sys',
      tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
      messages: USER_Q,
    });
    expect(JSON.stringify(captured[0].body)).not.toContain('cache_control');
  });

  it('serializes tool_use and tool_result history blocks, temperature, and auto tool_choice', async () => {
    respond = okText;
    await model().generate({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tu_1', toolName: 'lookup', input: { topic: 'x' } }] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'tu_1', toolName: 'lookup', output: { found: true }, isError: true }] },
      ],
      toolChoice: 'auto',
      temperature: 0.3,
      maxTokens: 100,
    });
    const body = captured[0].body;
    expect(body.messages[1].content).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'lookup', input: { topic: 'x' } }]);
    expect(body.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', content: '{"found":true}', is_error: true },
    ]);
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(100);
  });

  it('serializes thinking parts back in position — signature intact, redacted as its wire block', async () => {
    respond = okText;
    await model().generate({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'reasoning...', signature: 'sig_1' },
            { type: 'thinking', text: '', redacted: { data: 'opaque==' } },
            { type: 'tool-call', toolCallId: 'tu_1', toolName: 'lookup', input: {} },
          ],
        },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'tu_1', toolName: 'lookup', output: 'ok' }] },
      ],
    });
    // Thinking leads the assistant turn, exactly as it arrived: with thinking active the API
    // rejects a tool_use whose preceding thinking block is missing from the echo.
    expect(captured[0].body.messages[1].content).toEqual([
      { type: 'thinking', thinking: 'reasoning...', signature: 'sig_1' },
      { type: 'redacted_thinking', data: 'opaque==' },
      { type: 'tool_use', id: 'tu_1', name: 'lookup', input: {} },
    ]);
  });

  it('sends output_config.effort when effort is set — and never a thinking or budget_tokens field', async () => {
    respond = okText;
    await model().generate({ messages: USER_Q, effort: 'high' });
    expect(captured[0].body.output_config).toEqual({ effort: 'high' });
    // Adaptive thinking is the default the request must not disturb; budget_tokens is rejected
    // outright on current models.
    expect(captured[0].body.thinking).toBeUndefined();
    expect(JSON.stringify(captured[0].body)).not.toContain('budget_tokens');

    respond = okText;
    await model().generate({ messages: USER_Q });
    expect(captured[1].body.output_config).toBeUndefined();
  });
});

describe('anthropic generate', () => {
  it('maps content blocks, usage incl. cache fields, and tool_use stop_reason', async () => {
    respond = json(200, {
      content: [
        { type: 'text', text: 'Checking. ' },
        { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { topic: 'x' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 },
    });
    const out = await model().generate({ messages: USER_Q });
    expect(out.text).toBe('Checking. ');
    expect(out.toolCalls).toEqual([
      { type: 'tool-call', toolCallId: 'tu_1', toolName: 'lookup', input: { topic: 'x' } },
    ]);
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 25, cacheReadTokens: 40, cacheWriteTokens: 10 });
    expect(out.finishReason).toBe('tool-calls');
  });

  it('parses thinking blocks into result.thinking, never into text', async () => {
    respond = json(200, {
      content: [
        { type: 'thinking', thinking: 'quietly reasoning', signature: 'sig_1' },
        { type: 'redacted_thinking', data: 'opaque==' },
        { type: 'text', text: 'Answer.' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    const out = await model().generate({ messages: USER_Q });
    expect(out.text).toBe('Answer.');
    expect(out.thinking).toEqual([
      { type: 'thinking', text: 'quietly reasoning', signature: 'sig_1' },
      { type: 'thinking', text: '', redacted: { data: 'opaque==' } },
    ]);
    // Absent entirely when the model did not think — one-shot callers see no shape change.
    respond = okText;
    expect((await model().generate({ messages: USER_Q })).thinking).toBeUndefined();
  });

  it('maps max_tokens to length and an unknown stop_reason to other', async () => {
    respond = json(200, { content: [], stop_reason: 'max_tokens', usage: {} });
    expect((await model().generate({ messages: USER_Q })).finishReason).toBe('length');
    respond = json(200, { content: [], stop_reason: 'refusal', usage: {} });
    const out = await model().generate({ messages: USER_Q });
    expect(out.finishReason).toBe('other');
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});

describe('anthropic streaming', () => {
  it('parses the full event sequence even when frames split mid-token across network chunks', async () => {
    const full = [
      frame('message_start', { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 } } }),
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'lookup', input: {} } }),
      frame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"topic":' } }),
      frame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"derivatives"}' } }),
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 25 } }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('');
    // Cut INSIDE the second input_json_delta's data line — a frame boundary never seen by the
    // parser unless it buffers to \n\n.
    const cut = full.indexOf('derivatives') + 4;
    respond = sse([full.slice(0, cut), full.slice(cut)]);

    const events = await collect(model().stream({ messages: USER_Q }));
    expect(events).toEqual([
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', text: 'Let me check.' },
      { type: 'text-end', id: '0' },
      { type: 'tool-input-start', toolCallId: 'tu_1', toolName: 'lookup' },
      { type: 'tool-input-delta', toolCallId: 'tu_1', delta: '{"topic":' },
      { type: 'tool-input-delta', toolCallId: 'tu_1', delta: '"derivatives"}' },
      { type: 'tool-call', toolCallId: 'tu_1', toolName: 'lookup', input: { topic: 'derivatives' } },
      {
        type: 'finish', reason: 'tool-calls',
        usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 40, cacheWriteTokens: 10 },
      },
    ]);
    expect(captured[0].body.stream).toBe(true);
  });

  it('buffers server_tool_use into server-tool-call and surfaces web_search_tool_result', async () => {
    respond = sse([[
      frame('message_start', { type: 'message_start', message: { usage: { input_tokens: 5 } } }),
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} } }),
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"llm"}' } }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ url: 'https://a.example' }] } }),
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')]);

    const events = await collect(model().stream({ messages: USER_Q }));
    // No tool-input-start/delta for a provider-executed tool: it is announced whole.
    expect(events).toEqual([
      { type: 'server-tool-call', toolCallId: 'srv_1', toolName: 'web_search', input: { query: 'llm' } },
      { type: 'server-tool-result', toolCallId: 'srv_1', toolName: 'web_search', output: [{ url: 'https://a.example' }] },
      {
        type: 'finish', reason: 'stop',
        usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  it('streams a thinking block: deltas out, signature silent, assembled block on thinking-end', async () => {
    respond = sse([[
      frame('message_start', { type: 'message_start', message: { usage: { input_tokens: 7 } } }),
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'First, ' } }),
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'check.' } }),
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_' } }),
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      frame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } }),
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')]);
    const events = await collect(model().stream({ messages: USER_Q }));
    expect(events).toEqual([
      { type: 'thinking-start', id: '0' },
      { type: 'thinking-delta', id: '0', text: 'First, ' },
      { type: 'thinking-delta', id: '0', text: 'check.' },
      // signature_delta fragments never surface as deltas; the end event carries the whole
      // assembled block so the loop echoes without re-accumulating.
      { type: 'thinking-end', id: '0', text: 'First, check.', signature: 'sig_abc' },
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', text: 'Done.' },
      { type: 'text-end', id: '1' },
      {
        type: 'finish', reason: 'stop',
        usage: { inputTokens: 7, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  it('brackets a redacted_thinking block (whole on arrival) as start plus end with the payload', async () => {
    respond = sse([[
      frame('message_start', { type: 'message_start', message: { usage: {} } }),
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque==' } }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')]);
    const events = await collect(model().stream({ messages: USER_Q }));
    expect(events.slice(0, 2)).toEqual([
      { type: 'thinking-start', id: '0' },
      { type: 'thinking-end', id: '0', text: '', redacted: { data: 'opaque==' } },
    ]);
  });

  it('treats a tool_use block with no input deltas as {} input', async () => {
    respond = sse([[
      frame('message_start', { type: 'message_start', message: { usage: {} } }),
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'ping', input: {} } }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')]);
    const events = await collect(model().stream({ messages: USER_Q }));
    expect(events).toContainEqual({ type: 'tool-call', toolCallId: 'tu_1', toolName: 'ping', input: {} });
  });

  it('throws a retryable LlmHttpError on a mid-stream overloaded error event', async () => {
    respond = sse([[
      frame('message_start', { type: 'message_start', message: { usage: {} } }),
      frame('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    ].join('')]);
    const err = await collect(model().stream({ messages: USER_Q })).then(
      () => { throw new Error('stream did not throw'); },
      (e: unknown) => e as LlmHttpError,
    );
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err.status).toBe(529);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('Overloaded');
  });
});

describe('anthropic error taxonomy', () => {
  it('extracts the provider message and marks 429 retryable', async () => {
    respond = json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } });
    const err = await model().generate({ messages: USER_Q }).then(
      () => { throw new Error('did not throw'); },
      (e: unknown) => e as LlmHttpError,
    );
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err.provider).toBe('anthropic');
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('rate limited');
  });

  it('marks 529 overloaded retryable, also on the stream path', async () => {
    respond = json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    const err = await collect(model().stream({ messages: USER_Q })).then(
      () => { throw new Error('did not throw'); },
      (e: unknown) => e as LlmHttpError,
    );
    expect(err.status).toBe(529);
    expect(err.retryable).toBe(true);
  });

  it('keeps a status-line message for a non-JSON body and marks 400 non-retryable', async () => {
    respond = (res) => { res.statusCode = 400; res.end('bad gateway page'); };
    const err = await model().generate({ messages: USER_Q }).then(
      () => { throw new Error('did not throw'); },
      (e: unknown) => e as LlmHttpError,
    );
    expect(err.status).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('anthropic HTTP 400');
  });
});
