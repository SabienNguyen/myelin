import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { withRetries, anthropicModel, LlmHttpError } from '../../src/server/llm/index.js';

const NO_DELAY = { delayMs: () => 0 };

describe('withRetries', () => {
  it('retries a retryable LlmHttpError up to the limit, then succeeds', async () => {
    let attempts = 0;
    const out = await withRetries(async () => {
      attempts++;
      if (attempts < 3) throw new LlmHttpError('anthropic', 529, 'overloaded');
      return 'ok';
    }, NO_DELAY);
    expect(out).toBe('ok');
    expect(attempts).toBe(3); // first try + the default 2 retries
  });

  it('gives up after the retry budget and rethrows the last error', async () => {
    let attempts = 0;
    await expect(withRetries(async () => {
      attempts++;
      throw new LlmHttpError('anthropic', 429, 'rate limited');
    }, NO_DELAY)).rejects.toMatchObject({ status: 429 });
    expect(attempts).toBe(3);
  });

  it('does not retry a non-retryable status or an ordinary error', async () => {
    let attempts = 0;
    await expect(withRetries(async () => {
      attempts++;
      throw new LlmHttpError('anthropic', 400, 'bad request');
    }, NO_DELAY)).rejects.toMatchObject({ status: 400 });
    expect(attempts).toBe(1);

    let plain = 0;
    await expect(withRetries(async () => {
      plain++;
      throw new Error('logic bug');
    }, NO_DELAY)).rejects.toThrow('logic bug');
    expect(plain).toBe(1);
  });

  it('retries the network-level "fetch failed" TypeError', async () => {
    let attempts = 0;
    const out = await withRetries(async () => {
      attempts++;
      if (attempts === 1) throw new TypeError('fetch failed');
      return 'recovered';
    }, NO_DELAY);
    expect(out).toBe('recovered');
    expect(attempts).toBe(2);
  });
});

describe('adapter wiring', () => {
  it('a 529 then a 200 completes a generate() without surfacing the fault', async () => {
    let hits = 0;
    const server: Server = createServer((req, res) => {
      hits++;
      if (hits === 1) {
        res.writeHead(529, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        content: [{ type: 'text', text: 'CORRECT' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as { port: number };
    try {
      const model = anthropicModel({
        modelId: 'claude-test', apiKey: 'k',
        baseUrl: `http://127.0.0.1:${port}`,
        retry: { delayMs: () => 0 },
      });
      const out = await model.generate({ messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] });
      expect(out.text).toBe('CORRECT');
      expect(hits).toBe(2);
    } finally {
      server.close();
    }
  });
});
