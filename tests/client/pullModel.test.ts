// The pull-progress reader: turns Ollama's NDJSON stream into onProgress calls, resolves on a
// clean end, and rejects on a terminal {error} line or a non-stream error response.
import { describe, it, expect, vi } from 'vitest';
import { pullOllamaModel, type PullProgress } from '../../src/client/lib/pullModel.js';

function streamResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return { ok: true, body, status: 200 } as unknown as Response;
}

describe('pullOllamaModel', () => {
  it('reports percent from total/completed and null for size-less phases, then resolves', async () => {
    const seen: PullProgress[] = [];
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => streamResponse([
      '{"status":"pulling manifest"}\n',
      '{"status":"downloading","total":200,"completed":50}\n',
      '{"status":"downloading","total":200,"completed":200}\n',
      '{"status":"success"}\n',
    ]));
    await pullOllamaModel('qwen3:8b', (p) => seen.push(p), { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(seen).toEqual([
      { status: 'pulling manifest', percent: null },
      { status: 'downloading', percent: 25 },
      { status: 'downloading', percent: 100 },
      { status: 'success', percent: null },
    ]);
    // The POST carried the model name.
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ model: 'qwen3:8b' });
  });

  it('reassembles a JSON object split across two network chunks', async () => {
    const seen: PullProgress[] = [];
    const fetchImpl = vi.fn(async () => streamResponse([
      '{"status":"downl',
      'oading","total":10,"completed":10}\n{"status":"success"}\n',
    ]));
    await pullOllamaModel('m', (p) => seen.push(p), { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(seen).toEqual([
      { status: 'downloading', percent: 100 },
      { status: 'success', percent: null },
    ]);
  });

  it('rejects on a terminal {error} line, mid-stream', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([
      '{"status":"pulling manifest"}\n',
      '{"error":"pull model manifest: file does not exist"}\n',
    ]));
    await expect(pullOllamaModel('nope:1b', () => {}, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow(/file does not exist/);
  });

  it('rejects with the proxy error when the response is not a stream (Ollama unreachable)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 502, body: null, json: async () => ({ error: 'install it from ollama.com' }),
    } as unknown as Response));
    await expect(pullOllamaModel('m', () => {}, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow(/ollama\.com/);
  });
});
