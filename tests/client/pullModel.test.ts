// The pull watcher: POST starts the server-side background job, then GET /pulls polls the job —
// onProgress per poll, resolve on done, reject on the job's error or the POST's refusal. The
// NDJSON parsing these tests once covered client-side moved into the server's consumePull
// (setupRoutesHttp.test.ts pins it there, split chunks included).
import { describe, it, expect, vi } from 'vitest';
import { pullOllamaModel, watchPull, type PullProgress } from '../../src/client/lib/pullModel.js';

/** Serves the POST (202) and plays one jobs snapshot per GET; the last repeats. */
function pollFetch(states: object[]) {
  let i = 0;
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (String(url) === '/api/setup/models/pulls') {
      const s = states[Math.min(i++, states.length - 1)];
      return { ok: true, status: 200, json: async () => s } as unknown as Response;
    }
    return { ok: true, status: 202, json: async () => ({ started: true }) } as unknown as Response;
  });
}

describe('pullOllamaModel', () => {
  it('starts the job, relays each poll to onProgress, and resolves on done', async () => {
    const seen: PullProgress[] = [];
    const fetchImpl = pollFetch([
      { m: { status: 'pulling manifest', percent: null, error: null, done: false } },
      { m: { status: 'downloading', percent: 25, error: null, done: false } },
      { m: { status: 'success', percent: null, error: null, done: true } },
    ]);
    await pullOllamaModel('m', (p) => seen.push(p), { fetchImpl: fetchImpl as unknown as typeof fetch, pollMs: 1 });
    expect(seen).toEqual([
      { status: 'pulling manifest', percent: null },
      { status: 'downloading', percent: 25 },
      { status: 'success', percent: null },
    ]);
    // The POST carried the model name.
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'm' });
  });

  it("rejects on the job's error", async () => {
    const fetchImpl = pollFetch([
      { 'nope:1b': { status: 'pulling manifest', percent: null, error: 'pull model manifest: file does not exist', done: true } },
    ]);
    await expect(pullOllamaModel('nope:1b', () => {}, { fetchImpl: fetchImpl as unknown as typeof fetch, pollMs: 1 }))
      .rejects.toThrow(/file does not exist/);
  });

  it('rejects with the proxy error when the POST is refused (Ollama unreachable)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 502, json: async () => ({ error: 'install it from ollama.com' }),
    } as unknown as Response));
    await expect(pullOllamaModel('m', () => {}, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow(/ollama\.com/);
  });

  it('an aborted watch resolves quietly — the surface left, the server keeps downloading', async () => {
    const ctrl = new AbortController();
    const fetchImpl = pollFetch([
      { m: { status: 'downloading', percent: 10, error: null, done: false } },
    ]);
    await expect(watchPull('m', () => ctrl.abort(),
      { fetchImpl: fetchImpl as unknown as typeof fetch, signal: ctrl.signal, pollMs: 1 }))
      .resolves.toBeUndefined();
  });
});
