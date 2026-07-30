import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { openaiCompatModel, LlmHttpError, type StreamEvent } from '../../src/server/llm/index.js';
import { resetResponseFormatMemory } from '../../src/server/llm/openaiCompat.js';

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
beforeEach(() => { captured = []; resetResponseFormatMemory(); });

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

  it('sends reasoning_effort when effort is set, and drops assistant thinking parts (no echo here)', async () => {
    respond = okText;
    await model().generate({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'reasoning...', signature: 'sig_1' },
            { type: 'text', text: 'a' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
      ],
      effort: 'medium',
    });
    expect(captured[0].body.reasoning_effort).toBe('medium');
    // This wire has no reasoning field on assistant request messages — the part vanishes.
    expect(captured[0].body.messages[1]).toEqual({ role: 'assistant', content: 'a' });

    respond = okText;
    await model().generate({ messages: USER_Q });
    expect(captured[1].body.reasoning_effort).toBeUndefined();
  });

  it('streaming adds stream: true and stream_options.include_usage', async () => {
    respond = sse(['data: [DONE]\n\n']);
    await collect(model().stream({ messages: USER_Q }));
    expect(captured[0].body.stream).toBe(true);
    expect(captured[0].body.stream_options).toEqual({ include_usage: true });
  });
});

describe('openai-compat sampler mapping', () => {
  it('maps every sampler field to its wire name', async () => {
    respond = okText;
    await model().generate({
      messages: USER_Q,
      sampler: {
        topP: 0.9, topK: 40, minP: 0.05, seed: 7, stop: ['</s>', 'END'],
        repetitionPenalty: 1.1, frequencyPenalty: 0.2, presencePenalty: 0.1,
      },
    });
    const body = captured[0].body;
    expect(body.top_p).toBe(0.9);
    expect(body.top_k).toBe(40);
    expect(body.min_p).toBe(0.05);
    expect(body.seed).toBe(7);
    expect(body.stop).toEqual(['</s>', 'END']);
    expect(body.repetition_penalty).toBe(1.1);
    expect(body.frequency_penalty).toBe(0.2);
    expect(body.presence_penalty).toBe(0.1);
  });

  it('sends only the fields that are set — a partial block adds nothing else', async () => {
    respond = okText;
    await model().generate({ messages: USER_Q, sampler: { topK: 20, minP: 0.05 } });
    const body = captured[0].body;
    expect(body.top_k).toBe(20);
    expect(body.min_p).toBe(0.05);
    for (const k of ['top_p', 'seed', 'stop', 'repetition_penalty', 'frequency_penalty', 'presence_penalty']) {
      expect(body[k]).toBeUndefined();
    }
    // And no sampler at all leaves the wire untouched.
    respond = okText;
    await model().generate({ messages: USER_Q });
    expect(captured[1].body.top_k).toBeUndefined();
    expect(captured[1].body.min_p).toBeUndefined();
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

  it('reads message.reasoning_content into result.thinking (DeepSeek/LiteLLM convention)', async () => {
    respond = json(200, {
      choices: [{
        message: { content: 'Answer.', reasoning_content: 'quietly reasoning' },
        finish_reason: 'stop',
      }],
    });
    const out = await model().generate({ messages: USER_Q });
    expect(out.text).toBe('Answer.');
    expect(out.thinking).toEqual([{ type: 'thinking', text: 'quietly reasoning' }]);
    // Absent when the endpoint has no reasoning to report.
    respond = okText;
    expect((await model().generate({ messages: USER_Q })).thinking).toBeUndefined();
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

describe('openai-compat constrained decoding (responseSchema)', () => {
  const RF_REQ = {
    messages: USER_Q,
    responseSchema: { name: 'grade', schema: { type: 'object' } },
  };
  const toolOk = json(200, {
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grade', arguments: '{"a":1}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  });

  it('sends response_format json_schema strict, no tools, and returns the text as-is', async () => {
    respond = json(200, { choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] });
    const out = await model().generate(RF_REQ);
    expect(captured).toHaveLength(1);
    expect(captured[0].body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'grade', schema: { type: 'object' }, strict: true },
    });
    expect(captured[0].body.tools).toBeUndefined();
    expect(captured[0].body.tool_choice).toBeUndefined();
    expect(out.text).toBe('{"a":1}');
    expect(out.toolCalls).toEqual([]);
  });

  it('a rejected response_format falls back to the forced tool once, remembered per endpoint', async () => {
    respond = (res) => (captured.length === 1
      ? json(400, { error: { message: 'response_format is not supported' } })
      : toolOk)(res);
    const out = await model().generate(RF_REQ);
    // Fallback round-trip: the second request is the forced-tool form of the same call.
    expect(captured).toHaveLength(2);
    expect(captured[1].body.response_format).toBeUndefined();
    expect(captured[1].body.tools).toEqual([{
      type: 'function',
      function: { name: 'grade', description: 'Report the result in the required structure.', parameters: { type: 'object' } },
    }]);
    expect(captured[1].body.tool_choice).toEqual({ type: 'function', function: { name: 'grade' } });
    expect(out.toolCalls).toEqual([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'grade', input: { a: 1 } },
    ]);

    // Remembered: the next call on the same endpoint goes straight to the tool path — ONE request.
    await model().generate(RF_REQ);
    expect(captured).toHaveLength(3);
    expect(captured[2].body.response_format).toBeUndefined();
    expect(captured[2].body.tool_choice).toEqual({ type: 'function', function: { name: 'grade' } });
  });

  it('a non-rejection failure (401) throws through and does not poison the memory', async () => {
    respond = json(401, { error: { message: 'bad key' } });
    await expect(model('sk-x').generate(RF_REQ)).rejects.toThrow('bad key');
    expect(captured).toHaveLength(1);
    // The endpoint was NOT remembered as rejecting: the next call still tries response_format.
    respond = json(200, { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
    await model().generate(RF_REQ);
    expect(captured[1].body.response_format).toBeDefined();
  });

  it('responseSchema never rides alongside real tools', async () => {
    respond = okText;
    await model().generate({
      ...RF_REQ,
      tools: [{ name: 'lookup', description: 'd', inputSchema: { type: 'object' } }],
    });
    expect(captured[0].body.response_format).toBeUndefined();
    expect(captured[0].body.tools).toHaveLength(1);
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

  it('parses reasoning_content deltas into thinking events, closing on the first content delta', async () => {
    respond = sse([[
      data({ choices: [{ index: 0, delta: { reasoning_content: 'Hmm, ' } }] }),
      data({ choices: [{ index: 0, delta: { reasoning_content: 'maybe.' } }] }),
      data({ choices: [{ index: 0, delta: { content: 'Answer' } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      data({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      'data: [DONE]\n\n',
    ].join('')]);
    const events = await collect(model().stream({ messages: USER_Q }));
    expect(events).toEqual([
      { type: 'thinking-start', id: 'reasoning-0' },
      { type: 'thinking-delta', id: 'reasoning-0', text: 'Hmm, ' },
      { type: 'thinking-delta', id: 'reasoning-0', text: 'maybe.' },
      // Closed with the assembled text before any answer text opens — the loop mirrors this
      // order onto the transcript. No signature on this wire.
      { type: 'thinking-end', id: 'reasoning-0', text: 'Hmm, maybe.' },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', text: 'Answer' },
      { type: 'text-end', id: '0' },
      {
        type: 'finish', reason: 'stop',
        usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  it('closes a reasoning-only stream at the end rather than leaving the block open', async () => {
    respond = sse([[
      data({ choices: [{ index: 0, delta: { reasoning_content: 'cut off' } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
      'data: [DONE]\n\n',
    ].join('')]);
    const events = await collect(model().stream({ messages: USER_Q }));
    expect(events).toEqual([
      { type: 'thinking-start', id: 'reasoning-0' },
      { type: 'thinking-delta', id: 'reasoning-0', text: 'cut off' },
      { type: 'thinking-end', id: 'reasoning-0', text: 'cut off' },
      {
        type: 'finish', reason: 'length',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
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

// The qwen3-class convention: reasoning arrives INSIDE message.content as a leading
// <think>…</think> block rather than in reasoning_content.
describe('openai-compat <think> tag extraction', () => {
  const content = (text: string) =>
    json(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }] });

  it('generate lifts a leading think block into result.thinking, leaving structured JSON parseable', async () => {
    respond = content('<think>step by step</think>\n{"a":1}');
    const out = await model().generate({
      messages: USER_Q, responseSchema: { name: 'grade', schema: { type: 'object' } },
    });
    expect(out.thinking).toEqual([{ type: 'thinking', text: 'step by step' }]);
    // The exact failure this fixes: parseStructuredText choked on the think prefix.
    expect(out.text).toBe('{"a":1}');
    expect(JSON.parse(out.text)).toEqual({ a: 1 });
  });

  it('generate allows leading whitespace before the tag and trims the separator after it', async () => {
    respond = content('\n <think>a</think>\n\nb');
    const out = await model().generate({ messages: USER_Q });
    expect(out.thinking).toEqual([{ type: 'thinking', text: 'a' }]);
    expect(out.text).toBe('b');
  });

  it('generate keeps a mid-text <think> literal — a model quoting the token is not thinking', async () => {
    respond = content('Use the <think> tag to hide reasoning.');
    const out = await model().generate({ messages: USER_Q });
    expect(out.thinking).toBeUndefined();
    expect(out.text).toBe('Use the <think> tag to hide reasoning.');
  });

  it('generate: an unclosed think block is all thinking, empty text (cut off mid-thought)', async () => {
    respond = content('<think>cut off');
    const out = await model().generate({ messages: USER_Q });
    expect(out.thinking).toEqual([{ type: 'thinking', text: 'cut off' }]);
    expect(out.text).toBe('');
  });

  it('generate: reasoning_content wins — think tags then pass through as literal text', async () => {
    respond = json(200, {
      choices: [{
        message: { content: '<think>x</think>y', reasoning_content: 'r' },
        finish_reason: 'stop',
      }],
    });
    const out = await model().generate({ messages: USER_Q });
    expect(out.thinking).toEqual([{ type: 'thinking', text: 'r' }]);
    expect(out.text).toBe('<think>x</think>y');
  });

  it('stream extracts think events with both tags split at awkward points across deltas', async () => {
    respond = sse([
      // <th | ink>fo | o</thi | nk>bar — every split lands inside a tag.
      data({ choices: [{ index: 0, delta: { content: '<th' } }] }),
      data({ choices: [{ index: 0, delta: { content: 'ink>fo' } }] }),
      data({ choices: [{ index: 0, delta: { content: 'o</thi' } }] }),
      data({ choices: [{ index: 0, delta: { content: 'nk>bar' } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]);
    const events = await collect(model().stream({ messages: USER_Q }));
    expect(events).toEqual([
      { type: 'thinking-start', id: 'think-tag-0' },
      { type: 'thinking-delta', id: 'think-tag-0', text: 'fo' },
      { type: 'thinking-delta', id: 'think-tag-0', text: 'o' },
      { type: 'thinking-end', id: 'think-tag-0', text: 'foo' },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', text: 'bar' },
      { type: 'text-end', id: '0' },
      {
        type: 'finish', reason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  it('stream keeps a mid-text <think> literal', async () => {
    respond = sse([[
      data({ choices: [{ index: 0, delta: { content: 'Hi <think>x</think>' } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ].join('')]);
    const events = await collect(model().stream({ messages: USER_Q }));
    const text = events.filter((e) => e.type === 'text-delta').map((e) => e.text).join('');
    expect(text).toBe('Hi <think>x</think>');
    expect(events.some((e) => e.type === 'thinking-start')).toBe(false);
  });

  it('stream: reasoning_content wins and content think tags stay literal text', async () => {
    respond = sse([[
      data({ choices: [{ index: 0, delta: { reasoning_content: 'Hmm' } }] }),
      data({ choices: [{ index: 0, delta: { content: '<think>x</think>y' } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ].join('')]);
    const events = await collect(model().stream({ messages: USER_Q }));
    expect(events).toEqual([
      { type: 'thinking-start', id: 'reasoning-0' },
      { type: 'thinking-delta', id: 'reasoning-0', text: 'Hmm' },
      { type: 'thinking-end', id: 'reasoning-0', text: 'Hmm' },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', text: '<think>x</think>y' },
      { type: 'text-end', id: '0' },
      {
        type: 'finish', reason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  it('stream closes an unclosed think block at stream end, deltas summing to the assembled text', async () => {
    respond = sse([[
      data({ choices: [{ index: 0, delta: { content: '<think>never ends' } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
      'data: [DONE]\n\n',
    ].join('')]);
    const events = await collect(model().stream({ messages: USER_Q }));
    expect(events).toEqual([
      { type: 'thinking-start', id: 'think-tag-0' },
      { type: 'thinking-delta', id: 'think-tag-0', text: 'never ends' },
      { type: 'thinking-end', id: 'think-tag-0', text: 'never ends' },
      {
        type: 'finish', reason: 'length',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });
});

// The Hermes/NousResearch convention: tool calls as <tool_call>{…}</tool_call> blocks in content
// instead of the tool_calls API field. Scanned only when the request declared function tools.
describe('openai-compat <tool_call> tag parsing (hermes)', () => {
  const TOOLS = [{ name: 'lookup', description: 'd', inputSchema: { type: 'object' as const } }];
  const content = (text: string) =>
    json(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }] });

  it('generate parses object arguments, strips the block, and mints synthetic ids in order', async () => {
    respond = content(
      'Calling now.\n<tool_call>{"name":"lookup","arguments":{"topic":"x"}}</tool_call>'
      + '<tool_call>{"name":"lookup","arguments":{"topic":"y"}}</tool_call>',
    );
    const out = await model().generate({ messages: USER_Q, tools: TOOLS });
    expect(out.toolCalls).toEqual([
      { type: 'tool-call', toolCallId: 'hermes_0', toolName: 'lookup', input: { topic: 'x' } },
      { type: 'tool-call', toolCallId: 'hermes_1', toolName: 'lookup', input: { topic: 'y' } },
    ]);
    expect(out.text).toBe('Calling now.\n');
  });

  it('generate handles string arguments (OpenAI-style leakage inside the hermes shape)', async () => {
    respond = content('<tool_call>{"name":"lookup","arguments":"{\\"topic\\":\\"x\\"}"}</tool_call>');
    const out = await model().generate({ messages: USER_Q, tools: TOOLS });
    expect(out.toolCalls).toEqual([
      { type: 'tool-call', toolCallId: 'hermes_0', toolName: 'lookup', input: { topic: 'x' } },
    ]);
    expect(out.text).toBe('');
  });

  it('generate leaves a malformed block as literal text — a mangled call must not kill the turn', async () => {
    const raw = 'a <tool_call>{"name": "lookup", "arguments": {broken}</tool_call> b';
    respond = content(raw);
    const out = await model().generate({ messages: USER_Q, tools: TOOLS });
    expect(out.toolCalls).toEqual([]);
    expect(out.text).toBe(raw);
  });

  it('generate with NO declared function tools keeps even a valid block literal (no phantom calls)', async () => {
    const raw = '<tool_call>{"name":"lookup","arguments":{}}</tool_call>';
    respond = content(raw);
    const out = await model().generate({ messages: USER_Q });
    expect(out.toolCalls).toEqual([]);
    expect(out.text).toBe(raw);
  });

  it('generate extracts a think block first, then the tool_call from what remains', async () => {
    respond = content('<think>t</think><tool_call>{"name":"lookup","arguments":{}}</tool_call>');
    const out = await model().generate({ messages: USER_Q, tools: TOOLS });
    expect(out.thinking).toEqual([{ type: 'thinking', text: 't' }]);
    expect(out.toolCalls).toEqual([
      { type: 'tool-call', toolCallId: 'hermes_0', toolName: 'lookup', input: {} },
    ]);
    expect(out.text).toBe('');
  });

  it('stream assembles a call from tags split across deltas, text flowing around the block', async () => {
    respond = sse([
      data({ choices: [{ index: 0, delta: { content: 'before <tool' } }] }),
      data({ choices: [{ index: 0, delta: { content: '_call>{"name":"lookup","argu' } }] }),
      data({ choices: [{ index: 0, delta: { content: 'ments":{"a":1}}</tool_' } }] }),
      data({ choices: [{ index: 0, delta: { content: 'call> after' } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]);
    const events = await collect(model().stream({ messages: USER_Q, tools: TOOLS }));
    expect(events).toEqual([
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', text: 'before ' },
      // Start fires the moment the open tag is confirmed; the name only exists once the JSON
      // closes, so it starts empty — the wire keys tool parts by id, and tool-call carries it.
      { type: 'tool-input-start', toolCallId: 'hermes_0', toolName: '' },
      { type: 'tool-call', toolCallId: 'hermes_0', toolName: 'lookup', input: { a: 1 } },
      { type: 'text-delta', id: '0', text: ' after' },
      { type: 'text-end', id: '0' },
      {
        type: 'finish', reason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  it('stream reverts a malformed block to literal text — the already-sent input-start is inert', async () => {
    respond = sse([[
      data({ choices: [{ index: 0, delta: { content: '<tool_call>{"name": broken}</tool_call>done' } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ].join('')]);
    const events = await collect(model().stream({ messages: USER_Q, tools: TOOLS }));
    expect(events).toEqual([
      { type: 'tool-input-start', toolCallId: 'hermes_0', toolName: '' },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', text: '<tool_call>{"name": broken}</tool_call>' },
      { type: 'text-delta', id: '0', text: 'done' },
      { type: 'text-end', id: '0' },
      {
        type: 'finish', reason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  it('stream with NO declared function tools passes tags through as plain text', async () => {
    respond = sse([[
      data({ choices: [{ index: 0, delta: { content: 'x <tool_call>{"name":"lookup","arguments":{}}</tool_call>' } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ].join('')]);
    const events = await collect(model().stream({ messages: USER_Q }));
    const text = events.filter((e) => e.type === 'text-delta').map((e) => e.text).join('');
    expect(text).toBe('x <tool_call>{"name":"lookup","arguments":{}}</tool_call>');
    expect(events.some((e) => e.type === 'tool-input-start' || e.type === 'tool-call')).toBe(false);
  });

  it('stream: an unterminated block flushes as literal text at stream end', async () => {
    respond = sse([[
      data({ choices: [{ index: 0, delta: { content: '<tool_call>{"name":"lookup"' } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
      'data: [DONE]\n\n',
    ].join('')]);
    const events = await collect(model().stream({ messages: USER_Q, tools: TOOLS }));
    const text = events.filter((e) => e.type === 'text-delta').map((e) => e.text).join('');
    expect(text).toBe('<tool_call>{"name":"lookup"');
    expect(events.some((e) => e.type === 'tool-call')).toBe(false);
  });
});
