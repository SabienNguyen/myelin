import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { openaiCompatModel, LlmHttpError, type StreamEvent } from '../../src/server/llm/index.js';

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
  choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

const data = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of iter) events.push(ev);
  return events;
}

// Zero-delay retries — see anthropic.test.ts's model() note.
const model = (apiKey?: string) => openaiCompatModel({ modelId: 'llama3', baseUrl: `${base}/v1`, apiKey, retry: { delayMs: () => 0 } });
const USER_Q = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'q' }] }];

describe('openai-compat request shaping', () => {
  it('round-trips the tool conversation shapes with a bearer key', async () => {
    respond = okText;
    await model('sk-x').generate({
      system: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: { topic: 'x' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'lookup', output: { found: true } }] },
      ],
      tools: [
        { name: 'lookup', description: 'd', inputSchema: { type: 'object' } },
        // Anthropic-only surface: must be dropped, not sent as a malformed function tool.
        { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
      ],
      toolChoice: { name: 'lookup' },
      maxTokens: 100,
      temperature: 0.2,
    });
    const sent = captured[0];
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.headers.authorization).toBe('Bearer sk-x');
    expect(sent.body.model).toBe('llama3');
    expect(sent.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      {
        role: 'assistant', content: 'calling',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"topic":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"found":true}' },
    ]);
    expect(sent.body.tools).toEqual([
      { type: 'function', function: { name: 'lookup', description: 'd', parameters: { type: 'object' } } },
    ]);
    expect(sent.body.tool_choice).toEqual({ type: 'function', function: { name: 'lookup' } });
    expect(sent.body.max_tokens).toBe(100);
    expect(sent.body.temperature).toBe(0.2);
    expect(sent.body.stream).toBeUndefined();
    expect(sent.body.stream_options).toBeUndefined();
  });

  it('sends no Authorization header without a key — the local Ollama case', async () => {
    respond = okText;
    await model().generate({ messages: USER_Q, toolChoice: 'auto' });
    expect(captured[0].headers.authorization).toBeUndefined();
    expect(captured[0].body.tool_choice).toBe('auto');
  });

  it('streaming adds stream: true and stream_options.include_usage', async () => {
    respond = sse(['data: [DONE]\n\n']);
    await collect(model().stream({ messages: USER_Q }));
    expect(captured[0].body.stream).toBe(true);
    expect(captured[0].body.stream_options).toEqual({ include_usage: true });
  });
});

describe('openai-compat generate', () => {
  it('maps message content, tool_calls with JSON-string arguments, and usage', async () => {
    respond = json(200, {
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"topic":"x"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 9, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } },
    });
    const out = await model().generate({ messages: USER_Q });
    expect(out.text).toBe('');
    expect(out.toolCalls).toEqual([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: { topic: 'x' } },
    ]);
    expect(out.finishReason).toBe('tool-calls');
    expect(out.usage).toEqual({ inputTokens: 9, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 0 });
  });

  it('maps length and unknown finish_reasons', async () => {
    respond = json(200, { choices: [{ message: { content: 'x' }, finish_reason: 'length' }] });
    expect((await model().generate({ messages: USER_Q })).finishReason).toBe('length');
    respond = json(200, { choices: [{ message: { content: 'x' }, finish_reason: 'content_filter' }] });
    const out = await model().generate({ messages: USER_Q });
    expect(out.finishReason).toBe('other');
    // No usage on the wire at all: zeros, not NaN or undefined.
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('throws LlmHttpError with the provider message on non-2xx', async () => {
    respond = json(500, { error: { message: 'model not loaded' } });
    const err = await model().generate({ messages: USER_Q }).then(
      () => { throw new Error('did not throw'); },
      (e: unknown) => e as LlmHttpError,
    );
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err.provider).toBe('openai-compat');
    expect(err.status).toBe(500);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('model not loaded');
  });
});

describe('openai-compat streaming', () => {
  it('synthesizes text bounds, assembles a call, and reads the empty-choices usage chunk', async () => {
    respond = sse([
      data({ choices: [{ index: 0, delta: { content: 'Hel' } }] }),
      data({ choices: [{ index: 0, delta: { content: 'lo' } }] })
        + data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'lookup', arguments: '{"to' } }] } }] }),
      data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'pic":"x"}' } }] } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      // The usage-bearing final chunk arrives with EMPTY choices (stream_options.include_usage).
      data({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } }),
      'data: [DONE]\n\n',
    ]);
    const events = await collect(model().stream({ messages: USER_Q }));
    expect(events).toEqual([
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', text: 'Hel' },
      { type: 'text-delta', id: '0', text: 'lo' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'lookup' },
      { type: 'tool-input-delta', toolCallId: 'c1', delta: '{"to' },
      { type: 'tool-input-delta', toolCallId: 'c1', delta: 'pic":"x"}' },
      { type: 'text-end', id: '0' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: { topic: 'x' } },
      {
        type: 'finish', reason: 'tool-calls',
        usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  it('assembles interleaved fragments by index — id and name arrive on the first fragment only', async () => {
    respond = sse([[
      data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c_a', function: { name: 'alpha', arguments: '{"a"' } }] } }] }),
      data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'c_b', function: { name: 'beta', arguments: '{"b"' } }] } }] }),
      data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] }),
      data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: ':2}' } }] } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ].join('')]);
    const events = await collect(model().stream({ messages: USER_Q }));
    const calls = events.filter((e) => e.type === 'tool-call');
    expect(calls).toEqual([
      { type: 'tool-call', toolCallId: 'c_a', toolName: 'alpha', input: { a: 1 } },
      { type: 'tool-call', toolCallId: 'c_b', toolName: 'beta', input: { b: 2 } },
    ]);
    const finish = events.at(-1);
    expect(finish).toMatchObject({ type: 'finish', reason: 'tool-calls' });
  });

  it('maps a plain text stream ending in stop, with [DONE] terminating cleanly', async () => {
    respond = sse([[
      data({ choices: [{ index: 0, delta: { content: 'Hi' } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      data({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } }),
      'data: [DONE]\n\n',
    ].join('')]);
    const events = await collect(model().stream({ messages: USER_Q }));
    expect(events).toEqual([
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', text: 'Hi' },
      { type: 'text-end', id: '0' },
      {
        type: 'finish', reason: 'stop',
        usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });
});
