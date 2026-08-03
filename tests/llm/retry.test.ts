import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { withRetries, anthropicModel, LlmHttpError } from '../../src/server/llm/index.js';
import { errorFromResponse } from '../../src/server/llm/types.js';
import { MAX_RETRY_WAIT_MS } from '../../src/server/llm/retry.js';

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

/**
 * A rate limit is the one failure that reports its own cure. Blind 2s+4s backoff against a limit
 * that asked for 6.8s meant every attempt landed early and the turn died with no output at all —
 * the learner saw an empty reply to "keep going".
 */
describe('provider-stated retry delays', () => {
  const rateLimited = (msg: string, headers: Record<string, string> = {}) => ({
    ok: false,
    status: 429,
    headers: new Headers(headers),
    text: async () => JSON.stringify({ error: { message: msg } }),
  }) as unknown as Response;

  it('reads the seconds OpenAI embeds in the message when no header is present', async () => {
    const e = await errorFromResponse('openai', rateLimited('Rate limit reached. Please try again in 6.826s.'));
    expect(e.status).toBe(429);
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBeCloseTo(6826, 0);
  });

  it('prefers the retry-after header', async () => {
    const e = await errorFromResponse('openai', rateLimited('slow down', { 'retry-after': '12' }));
    expect(e.retryAfterMs).toBe(12_000);
  });

  it('leaves retryAfterMs undefined when the provider says nothing', async () => {
    const e = await errorFromResponse('openai', rateLimited('too many requests'));
    expect(e.retryAfterMs).toBeUndefined();
  });

  it('recovers from a rate limit once the stated wait is honoured', async () => {
    let n = 0;
    const fn = async () => {
      n += 1;
      // 1ms stated delay: the point under test is that a 429 carrying its own delay RECOVERS,
      // not that the wall clock advanced.
      if (n < 3) throw new LlmHttpError('openai', 429, 'try again in 0.001s', 1);
      return 'ok';
    };
    await expect(withRetries(fn, { delayMs: () => 0 })).resolves.toBe('ok');
    expect(n).toBe(3);
  });

  it('caps a provider-stated wait so a turn cannot be parked indefinitely', async () => {
    const e = new LlmHttpError('openai', 429, 'try again in 600s', 600_000);
    expect(e.retryAfterMs).toBe(600_000);
    expect(MAX_RETRY_WAIT_MS).toBeLessThanOrEqual(30_000);
  });
});
