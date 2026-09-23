import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { openaiResponsesModel, LlmHttpError, type StreamEvent } from '../../src/server/llm/index.js';

// Same pattern as anthropic.test.ts / openaiCompat.test.ts: a fake Responses endpoint capturing
// what actually leaves the process, since request shaping is exactly the part reading the
// adapter cannot verify.
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
// arrives as a separate read on the client side (mirrors anthropic.test.ts / openaiCompat.test.ts).
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

const frame = (obj: unknown) => `event: ${(obj as { type: string }).type}\ndata: ${JSON.stringify(obj)}\n\n`;

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of iter) events.push(ev);
  return events;
}

// Zero-delay retries — see anthropic.test.ts's model() note.
const model = () => openaiResponsesModel({ modelId: 'gpt-x', apiKey: 'k', baseUrl: base, retry: { delayMs: () => 0 } });
const USER_Q = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'q' }] }];

const usageEvent = frame({
  type: 'response.completed',
  response: {
    status: 'completed',
    usage: {
      input_tokens: 10, output_tokens: 5,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 1 },
    },
  },
});

describe('openai responses request shaping', () => {
  it('POSTs /responses with store:false, include reasoning.encrypted_content, and stream:true', async () => {
    respond = sse([usageEvent]);
    await collect(model().stream({ system: 'sys', messages: USER_Q }));
    const sent = captured[0];
    expect(sent.url).toBe('/responses');
    expect(sent.headers.authorization).toBe('Bearer k');
    expect(sent.body.model).toBe('gpt-x');
    expect(sent.body.instructions).toBe('sys');
    expect(sent.body.store).toBe(false);
    expect(sent.body.include).toEqual(['reasoning.encrypted_content']);
    expect(sent.body.stream).toBe(true);
  });

  it('maps a tool round-trip to input items: function_call and function_call_output', async () => {
    respond = sse([usageEvent]);
    await collect(model().stream({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'lookup', input: { q: 'x' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'lookup', output: { found: true } }],
        },
      ],
    }));
    const input = captured[0].body.input;
    expect(input).toContainEqual({ type: 'message', role: 'user', content: 'q' });
    expect(input).toContainEqual({
      type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: JSON.stringify({ q: 'x' }),
    });
    expect(input).toContainEqual({
      type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ found: true }),
    });
  });

  it('stringifies non-string tool-result output but passes a string result through untouched', async () => {
    respond = sse([usageEvent]);
    await collect(model().stream({
      messages: [
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'lookup', output: 'plain text' }] },
      ],
    }));
    expect(captured[0].body.input).toContainEqual({
      type: 'function_call_output', call_id: 'call_1', output: 'plain text',
    });
  });

  it('sends reasoning.effort alongside tools — the point of this route', async () => {
    respond = sse([usageEvent]);
    await collect(model().stream({
      messages: USER_Q,
      effort: 'high',
      tools: [{ name: 'lookup', description: 'd', inputSchema: { type: 'object' } }],
    }));
    const body = captured[0].body;
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.tools).toEqual([{ type: 'function', name: 'lookup', description: 'd', parameters: { type: 'object' }, strict: false }]);
  });

  it('maps the web_search ServerTool to a bare {type: "web_search"} tool', async () => {
    respond = sse([usageEvent]);
    await collect(model().stream({
      messages: USER_Q,
      tools: [{ type: 'web_search', name: 'web_search' }],
    }));
    expect(captured[0].body.tools).toEqual([{ type: 'web_search' }]);
  });

  it('adds web_search_call.action.sources to include when the web_search tool is offered', async () => {
    respond = sse([usageEvent]);
    await collect(model().stream({
      messages: USER_Q,
      tools: [{ type: 'web_search', name: 'web_search' }],
    }));
    expect(captured[0].body.include).toEqual(['reasoning.encrypted_content', 'web_search_call.action.sources']);
  });

  it('does not add web_search_call.action.sources when no web_search tool is offered', async () => {
    respond = sse([usageEvent]);
    await collect(model().stream({
      messages: USER_Q,
      tools: [{ name: 'lookup', description: 'd', inputSchema: { type: 'object' } }],
    }));
    expect(captured[0].body.include).toEqual(['reasoning.encrypted_content']);
  });

  it('throws a clear error for an unknown ServerTool type instead of silently dropping it', async () => {
    respond = sse([usageEvent]);
    await expect(collect(model().stream({
      messages: USER_Q,
      tools: [{ type: 'web_search_20260209', name: 'web_search' }],
    }))).rejects.toThrow(/web_search_20260209/);
    expect(captured).toHaveLength(0);
  });

  it('maps toolChoice, maxTokens, temperature/top_p, and skips local-model sampler knobs', async () => {
    respond = sse([usageEvent]);
    await collect(model().stream({
      messages: USER_Q,
      toolChoice: { name: 'lookup' },
      maxTokens: 500,
      temperature: 0.4,
      sampler: { topP: 0.9, topK: 40, minP: 0.05, repetitionPenalty: 1.1 },
      tools: [{ name: 'lookup', description: 'd', inputSchema: { type: 'object' } }],
    }));
    const body = captured[0].body;
    expect(body.tool_choice).toEqual({ type: 'function', name: 'lookup' });
    expect(body.max_output_tokens).toBe(500);
    expect(body.temperature).toBe(0.4);
    expect(body.top_p).toBe(0.9);
    expect(body.top_k).toBeUndefined();
    expect(body.min_p).toBeUndefined();
    expect(body.repetition_penalty).toBeUndefined();
  });

  it('maps responseSchema to text.format json_schema only when there are no function tools', async () => {
    respond = sse([usageEvent]);
    await collect(model().stream({
      messages: USER_Q,
      responseSchema: { name: 'answer', schema: { type: 'object' } },
    }));
    expect(captured[0].body.text).toEqual({
      format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true },
    });
  });
});

describe('openai responses streaming', () => {
  it('streams output_text deltas as text-start/text-delta/text-end', async () => {
    respond = sse([
      frame({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } }),
      frame({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hel' }),
      frame({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'lo' }),
      frame({ type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] } }),
      usageEvent,
    ]);
    const events = await collect(model().stream({ messages: USER_Q }));
    expect(events).toContainEqual({ type: 'text-start', id: 'msg_1' });
    expect(events).toContainEqual({ type: 'text-delta', id: 'msg_1', text: 'Hel' });
    expect(events).toContainEqual({ type: 'text-delta', id: 'msg_1', text: 'lo' });
    expect(events).toContainEqual({ type: 'text-end', id: 'msg_1' });
  });

  it('assembles a function call with valid JSON arguments into tool-call', async () => {
    respond = sse([
      frame({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '' } }),
      frame({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"q":' }),
      frame({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '"x"}' }),
      frame({ type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' } }),
      usageEvent,
    ]);
    const events = await collect(model().stream({ messages: USER_Q }));
    expect(events).toContainEqual({ type: 'tool-input-start', toolCallId: 'call_1', toolName: 'lookup' });
    expect(events).toContainEqual({ type: 'tool-input-delta', toolCallId: 'call_1', delta: '{"q":' });
    expect(events).toContainEqual({ type: 'tool-call', toolCallId: 'call_1', toolName: 'lookup', input: { q: 'x' } });
    expect(events.find((e) => e.type === 'finish')).toEqual({
      type: 'finish', reason: 'tool-calls',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 },
    });
  });

  it('a function call with malformed JSON arguments sets inputError exactly as openaiCompat does', async () => {
    respond = sse([
      frame({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '' } }),
      frame({ type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q": bad' } }),
      usageEvent,
    ]);
    const events = await collect(model().stream({ messages: USER_Q }));
    const call = events.find((e) => e.type === 'tool-call') as any;
    expect(call.toolCallId).toBe('call_1');
    expect(call.input).toEqual({});
    expect(call.inputError).toMatch(/received: \{"q": bad/);
  });

  it('surfaces a web_search_call as server-tool-call + server-tool-result with query and cited URLs', async () => {
    respond = sse([
      frame({ type: 'response.output_item.added', output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'in_progress' } }),
      frame({
        type: 'response.output_item.done', output_index: 0,
        item: {
          id: 'ws_1', type: 'web_search_call', status: 'completed',
          action: { type: 'search', query: 'inference infra', sources: [{ url: 'https://a.com', title: 'A' }] },
        },
      }),
      frame({
        type: 'response.output_item.done', output_index: 1,
        item: {
          id: 'msg_2', type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'See [1]', annotations: [{ type: 'url_citation', url: 'https://b.com', title: 'B' }] }],
        },
      }),
      usageEvent,
    ]);
    const events = await collect(model().stream({ messages: USER_Q, tools: [{ type: 'web_search', name: 'web_search' }] }));
    expect(events).toContainEqual({
      type: 'server-tool-call', toolCallId: 'ws_1', toolName: 'web_search', input: { query: 'inference infra' },
    });
    expect(events).toContainEqual({
      type: 'server-tool-result', toolCallId: 'ws_1', toolName: 'web_search',
      output: {
        query: 'inference infra',
        sources: [{ url: 'https://a.com', title: 'A' }, { url: 'https://b.com', title: 'B' }],
      },
    });
  });

  it('a web_search_call with action.sources but no url_citation annotations still returns those URLs', async () => {
    respond = sse([
      frame({ type: 'response.output_item.added', output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'in_progress' } }),
      frame({
        type: 'response.output_item.done', output_index: 0,
        item: {
          id: 'ws_1', type: 'web_search_call', status: 'completed',
          action: {
            type: 'search', query: 'rust ownership',
            sources: [{ url: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html', title: 'Ch 4.1' }],
          },
        },
      }),
      // The model went straight into another tool call instead of citing inline — no
      // url_citation annotation anywhere in the turn, only the search's own action.sources.
      frame({
        type: 'response.output_item.done', output_index: 1,
        item: {
          id: 'msg_2', type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'Ownership means...', annotations: [] }],
        },
      }),
      usageEvent,
    ]);
    const events = await collect(model().stream({ messages: USER_Q, tools: [{ type: 'web_search', name: 'web_search' }] }));
    expect(events).toContainEqual({
      type: 'server-tool-result', toolCallId: 'ws_1', toolName: 'web_search',
      output: {
        query: 'rust ownership',
        sources: [{ url: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html', title: 'Ch 4.1' }],
      },
    });
  });

  it('keeps a url_citation title when action.sources has the same URL with no title', async () => {
    respond = sse([
      frame({ type: 'response.output_item.added', output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'in_progress' } }),
      frame({
        type: 'response.output_item.done', output_index: 0,
        item: {
          id: 'ws_1', type: 'web_search_call', status: 'completed',
          // action.sources came back with no title for this URL...
          action: { type: 'search', query: 'ownership', sources: [{ url: 'https://doc.rust-lang.org/book/ch04-01.html' }] },
        },
      }),
      frame({
        type: 'response.output_item.done', output_index: 1,
        item: {
          id: 'msg_2', type: 'message', role: 'assistant',
          // ...but the model's own inline citation for that same URL has one.
          content: [{
            type: 'output_text', text: 'See [1]',
            annotations: [{ type: 'url_citation', url: 'https://doc.rust-lang.org/book/ch04-01.html', title: 'What is Ownership?' }],
          }],
        },
      }),
      usageEvent,
    ]);
    const events = await collect(model().stream({ messages: USER_Q, tools: [{ type: 'web_search', name: 'web_search' }] }));
    expect(events).toContainEqual({
      type: 'server-tool-result', toolCallId: 'ws_1', toolName: 'web_search',
      output: {
        query: 'ownership',
        sources: [{ url: 'https://doc.rust-lang.org/book/ch04-01.html', title: 'What is Ownership?' }],
      },
    });
  });

  it('reasoning summary deltas stream as thinking events and round-trip into the next request', async () => {
    respond = sse([
      frame({ type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } }),
      frame({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'thinking' }),
      frame({ type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', encrypted_content: 'enc123', summary: [{ type: 'summary_text', text: 'thinking' }] } }),
      usageEvent,
    ]);
    const events = await collect(model().stream({ messages: USER_Q }));
    expect(events).toContainEqual({ type: 'thinking-start', id: 'rs_1' });
    expect(events).toContainEqual({ type: 'thinking-delta', id: 'rs_1', text: 'thinking' });
    const end = events.find((e) => e.type === 'thinking-end') as any;
    expect(end.text).toBe('thinking');
    expect(typeof end.signature).toBe('string');
    const packed = JSON.parse(end.signature);
    expect(packed).toEqual({ id: 'rs_1', encrypted_content: 'enc123' });

    // Round-trip: a ThinkingPart carrying that signature, followed by the tool call it preceded,
    // must come back as a `reasoning` input item ahead of the function_call.
    captured = [];
    respond = sse([usageEvent]);
    await collect(model().stream({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'thinking', signature: end.signature },
            { type: 'tool-call', toolCallId: 'call_1', toolName: 'lookup', input: {} },
          ],
        },
      ],
    }));
    expect(captured[0].body.input).toContainEqual({
      type: 'reasoning', id: 'rs_1', encrypted_content: 'enc123', summary: [],
    });
  });

  it('response.failed throws with the provider message', async () => {
    respond = sse([frame({ type: 'response.failed', response: { error: { message: 'provider blew up' } } })]);
    await expect(collect(model().stream({ messages: USER_Q }))).rejects.toThrow(/provider blew up/);
  });

  it('a top-level error event throws with the provider message', async () => {
    respond = sse([frame({ type: 'error', code: 'server_error', message: 'stream died' })]);
    await expect(collect(model().stream({ messages: USER_Q }))).rejects.toThrow(/stream died/);
  });

  it('a non-2xx response throws LlmHttpError the same way openaiCompat does', async () => {
    respond = json(500, { error: { message: 'boom' } });
    await expect(collect(model().stream({ messages: USER_Q }))).rejects.toThrow(LlmHttpError);
  });
});
