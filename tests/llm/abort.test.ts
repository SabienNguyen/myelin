// T1 — request timeouts and abort propagation. Three layers under test: withRetries's
// abort-aware backoff, the adapters' header timeout + caller-signal wiring into fetch, and
// runLoop / createUiStream carrying a disconnect down to the provider request.
import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  createUiStream, openaiCompatModel, runLoop, withRetries, zeroUsage,
  LlmHttpError, type ChatModel, type StreamEvent,
} from '../../src/server/llm/index.js';

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${port}/v1` };
}

describe('withRetries + AbortSignal', () => {
  it('an abort mid-backoff rejects immediately with the signal reason, not after the delay', async () => {
    const ctrl = new AbortController();
    let attempts = 0;
    const p = withRetries(async () => {
      attempts++;
      throw new LlmHttpError('openai-compat', 529, 'overloaded');
    }, { delayMs: () => 60_000, signal: ctrl.signal });
    // The first attempt has thrown and the retry is now sleeping 60s; the abort must cut it.
    const start = Date.now();
    setTimeout(() => ctrl.abort(new Error('client gone')), 10);
    await expect(p).rejects.toThrow('client gone');
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(attempts).toBe(1);
  });

  it('an already-aborted signal makes no attempt at all', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('gone before start'));
    let attempts = 0;
    await expect(withRetries(async () => { attempts++; return 'x'; }, { signal: ctrl.signal }))
      .rejects.toThrow('gone before start');
    expect(attempts).toBe(0);
  });

  it('an error thrown by an aborted attempt is not retried, whatever its shape', async () => {
    const ctrl = new AbortController();
    let attempts = 0;
    await expect(withRetries(async () => {
      attempts++;
      ctrl.abort(new Error('mid-attempt abort'));
      throw new LlmHttpError('openai-compat', 529, 'would otherwise retry');
    }, { delayMs: () => 0, signal: ctrl.signal })).rejects.toMatchObject({ status: 529 });
    expect(attempts).toBe(1);
  });
});

describe('adapter header timeout', () => {
  it('a server that never answers surfaces a retryable 408 after timeoutMs', async () => {
    // Never write a response; sockets are destroyed at the end so close() does not hang.
    const sockets: import('node:net').Socket[] = [];
    const { server, base } = await listen(() => { /* hold the request open */ });
    server.on('connection', (s) => sockets.push(s));
    try {
      const model = openaiCompatModel({
        modelId: 'm', baseUrl: base, timeoutMs: 40, retry: { retries: 1, delayMs: () => 0 },
      });
      let hits = 0;
      server.on('request', () => { hits++; });
      await expect(model.generate({ messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }))
        .rejects.toMatchObject({ status: 408, retryable: true });
      expect(hits).toBe(2); // the 408 is retryable: first try + the configured 1 retry
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
  });

  it('the timeout bounds HEADERS only — a stream that trickles past timeoutMs still completes', async () => {
    const { server, base } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
      res.write(chunk({ choices: [{ delta: { content: 'slow' } }] }));
      // Total body time (3 × 30ms) well past timeoutMs=50; headers arrived instantly.
      let n = 0;
      const t = setInterval(() => {
        n++;
        res.write(chunk({ choices: [{ delta: { content: ` part${n}` }, finish_reason: n === 3 ? 'stop' : null }] }));
        if (n === 3) {
          res.write('data: [DONE]\n\n');
          res.end();
          clearInterval(t);
        }
      }, 30);
    });
    try {
      const model = openaiCompatModel({ modelId: 'm', baseUrl: base, timeoutMs: 50 });
      let text = '';
      for await (const ev of model.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] })) {
        if (ev.type === 'text-delta') text += ev.text;
      }
      expect(text).toBe('slow part1 part2 part3');
    } finally {
      server.close();
    }
  });

  it('a caller abort mid-stream cancels the body read', async () => {
    let serverEnded = false;
    const { server, base } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n\n`);
      // Never finish; rely on the abort to tear the connection down.
      res.on('close', () => { serverEnded = true; });
    });
    const ctrl = new AbortController();
    try {
      const model = openaiCompatModel({ modelId: 'm', baseUrl: base });
      const events: string[] = [];
      await expect((async () => {
        for await (const ev of model.stream({
          messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
          signal: ctrl.signal,
        })) {
          events.push(ev.type);
          ctrl.abort(new Error('user navigated away'));
        }
      })()).rejects.toThrow('user navigated away');
      expect(events).toContain('text-delta');
      await new Promise((r) => setTimeout(r, 50));
      expect(serverEnded).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe('runLoop + AbortSignal', () => {
  const finish = (reason: 'stop' | 'tool-calls'): StreamEvent => ({ type: 'finish', reason, usage: zeroUsage() });

  it('forwards the signal into every model request', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const model: ChatModel = {
      generate() { throw new Error('unused'); },
      async *stream(req) {
        seen.push(req.signal);
        yield finish('stop');
      },
    };
    const ctrl = new AbortController();
    await runLoop({ model, messages: [], tools: [], maxSteps: 3, signal: ctrl.signal });
    expect(seen).toEqual([ctrl.signal]);
  });

  it('an abort during the stream stops the loop before tool execution', async () => {
    const ctrl = new AbortController();
    let executed = 0;
    const model: ChatModel = {
      generate() { throw new Error('unused'); },
      async *stream() {
        yield { type: 'tool-call', toolCallId: 't1', toolName: 'work', input: {} };
        ctrl.abort(new Error('disconnected'));
        yield finish('tool-calls');
      },
    };
    await expect(runLoop({
      model,
      messages: [],
      tools: [{
        name: 'work', description: 'd', inputSchema: { type: 'object' },
        execute: async () => { executed++; return 'done'; },
      }],
      maxSteps: 3,
      signal: ctrl.signal,
    })).rejects.toThrow('disconnected');
    expect(executed).toBe(0); // vault-writing side effects must not commit for an abandoned run
  });
});

describe('createUiStream + AbortSignal', () => {
  it('hands execute a signal that fires on upstream abort, and suppresses the error chunk', async () => {
    const upstream = new AbortController();
    let sawAbort = false;
    let ended = false;
    const res = createUiStream({
      originalMessages: [],
      signal: upstream.signal,
      onEnd: () => { ended = true; },
      execute: (_writer, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          reject(signal.reason);
        }, { once: true });
      }),
    });
    setTimeout(() => upstream.abort(new Error('tab closed')), 10);
    const body = await res.text();
    expect(sawAbort).toBe(true);
    expect(ended).toBe(true); // partial-turn persistence still runs
    expect(body).not.toContain('"type":"error"'); // nobody is reading; no error bubble either
    expect(body).toContain('"type":"finish"');
  });

  it('cancelling the response body does NOT abort the turn — it finishes for the reload', async () => {
    // A learner who reloads mid-answer used to have the turn killed here, and came back to an
    // assistant message holding tool calls and no text. The turn now runs to completion with
    // nobody listening so onEnd can persist a whole answer.
    let aborted = false;
    let finished = false;
    let ended: any = null;
    const res = createUiStream({
      originalMessages: [],
      execute: async (writer, signal) => {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        await new Promise((r) => setTimeout(r, 30)); // still working when the consumer leaves
        writer.write({ type: 'text-start', id: 't1' });
        writer.write({ type: 'text-delta', id: 't1', delta: 'the answer' });
        writer.write({ type: 'text-end', id: 't1' });
        finished = true;
      },
      onEnd: (e) => { ended = e; },
    });
    const reader = res.body!.getReader();
    await reader.read(); // the 'start' chunk
    await reader.cancel(new Error('consumer let go'));
    await new Promise((r) => setTimeout(r, 120));

    expect(aborted).toBe(false);   // the turn was never told to stop
    expect(finished).toBe(true);   // and it ran all the way through
    // The assembler still saw everything, so what onEnd persists is the COMPLETE answer.
    expect(JSON.stringify(ended?.messages ?? [])).toContain('the answer');
  });

});
