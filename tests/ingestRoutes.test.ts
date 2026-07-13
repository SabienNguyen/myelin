import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { buildIngestRoutes } from '../src/server/ingestRoutes.js';
import type { HarnessConfig } from '../src/server/config.js';
import type { Converter } from '../src/server/convert.js';

const fakeConverter: Converter = async () => ({
  markdown: '# Only Chapter\nSome fixture content for the route test.',
});

// compileNext only ever calls .listSlugs()/.tools() on the Loreweaver client — a plain stub is
// enough here; the real MCP round-trip is already covered by tests/ingest.test.ts.
function fakeLw() {
  return { listSlugs: async () => [] as string[], tools: async () => ({}) } as any;
}

function noToolModel() {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text: 'nothing to do' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    },
  });
}

function cfgFor(vault: string): HarnessConfig {
  return { vault, student: 'kid', models: {} } as unknown as HarnessConfig;
}

describe('ingest routes', () => {
  it('POST /api/ingest converts + queues; GET /api/ingest/queue reflects it', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: fakeConverter });

    const form = new FormData();
    form.append('file', new File(['fake pdf bytes'], 'My Book.pdf', { type: 'application/pdf' }));
    const res = await app.request('/api/ingest', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ book: 'My Book', chapters: 1 });

    const queue = await (await app.request('/api/ingest/queue')).json();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ book: 'My Book', status: 'pending' });
  });

  it('rejects a request with no file', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: fakeConverter });
    const res = await app.request('/api/ingest', { method: 'POST', body: new FormData() });
    expect(res.status).toBe(400);
  });

  it('POST /api/ingest/compile drains pending entries and reports a summary', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: fakeConverter, model: noToolModel() });

    const form = new FormData();
    form.append('file', new File(['fake pdf bytes'], 'Compile Me.pdf', { type: 'application/pdf' }));
    await app.request('/api/ingest', { method: 'POST', body: form });

    const res = await app.request('/api/ingest/compile', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ compiled: 1, failed: 0 });

    const queue = await (await app.request('/api/ingest/queue')).json();
    expect(queue[0].status).toBe('done');
  });
});
