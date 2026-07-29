import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { buildIngestRoutes } from '../src/server/ingestRoutes.js';
import { readQueue } from '../src/server/ingest.js';
import type { HarnessConfig } from '../src/server/config.js';
import type { Converter } from '../src/server/convert.js';

const fakeConverter: Converter = async () => ({
  markdown: '# Only Chapter\nSome fixture content for the route test.',
});

/** Poll until fn() is truthy — conversion now runs in the background after POST /api/ingest. */
async function until<T>(fn: () => T, ms = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('until(): timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}

// compileNext only ever calls .listSlugs()/.tools() on the Engram client — a plain stub is
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
    expect(await res.json()).toEqual({ book: 'My Book', converting: true });

    // Placeholder is visible immediately; background conversion swaps it for pending chapters.
    await until(() => readQueue(vault)[0]?.status === 'pending');
    const queue = await (await app.request('/api/ingest/queue')).json();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ book: 'My Book', status: 'pending', title: 'Only Chapter' });
  });

  it('PATCH /api/ingest/book renames across queue entries', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: fakeConverter });
    const form = new FormData();
    form.append('file', new File(['x'], 'Untitled Scan.pdf', { type: 'application/pdf' }));
    await app.request('/api/ingest', { method: 'POST', body: form });
    await until(() => readQueue(vault)[0]?.status === 'pending');

    const res = await app.request('/api/ingest/book', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ book: 'Untitled Scan', name: 'Linear Algebra Done Right' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ renamed: 1 });
    expect(readQueue(vault)[0].book).toBe('Linear Algebra Done Right');

    const missing = await app.request('/api/ingest/book', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ book: 'Nope', name: 'X' }),
    });
    expect(missing.status).toBe(404);
  });

  it('rejects a request with no file', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: fakeConverter });
    const res = await app.request('/api/ingest', { method: 'POST', body: new FormData() });
    expect(res.status).toBe(400);
  });

  it('POST /api/ingest/compile marks a no-op model run as error, never silently done', async () => {
    // The honesty gate: "the agent finished" is not "pages were written". A model that only
    // narrates (no write_page calls, no new slugs) must surface as a failed chapter — this is
    // exactly what local coder-tuned models do, observed live in the sandbox.
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: fakeConverter, model: noToolModel() });

    const form = new FormData();
    form.append('file', new File(['fake pdf bytes'], 'Compile Me.pdf', { type: 'application/pdf' }));
    await app.request('/api/ingest', { method: 'POST', body: form });
    await until(() => readQueue(vault)[0]?.status === 'pending');

    const res = await app.request('/api/ingest/compile', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ compiled: 0, failed: 1 });

    const queue = await (await app.request('/api/ingest/queue')).json();
    expect(queue[0].status).toBe('error');
    expect(queue[0].error).toMatch(/no pages/);
  });

  it('POST /api/ingest/compile accepts an optional concurrency passthrough (defaults to 1)', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: fakeConverter, model: noToolModel() });

    const form = new FormData();
    form.append('file', new File(['fake pdf bytes'], 'Concurrency Passthrough.pdf', { type: 'application/pdf' }));
    await app.request('/api/ingest', { method: 'POST', body: form });
    await until(() => readQueue(vault)[0]?.status === 'pending');

    // No body at all — must still default cleanly (n=1, concurrency=1), not throw on missing JSON.
    const noBody = await app.request('/api/ingest/compile', { method: 'POST' });
    expect(noBody.status).toBe(200);
    expect(await noBody.json()).toEqual({ compiled: 0, failed: 1 });
  });
});

describe('ingest routes — JSON url ingest', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/paper.pdf') {
        res.setHeader('content-type', 'application/pdf');
        res.end('%PDF-1.4 fixture bytes');
        return;
      }
      if (url.pathname === '/notapaper') {
        res.setHeader('content-type', 'text/html');
        res.end('<html>nope</html>');
        return;
      }
      res.statusCode = 404; res.end('nope');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const paperConverter: Converter = async () => ({
    markdown: '# Fixture Paper Title\nAbstract text.\n## Section\nMore text.',
  });

  it('downloads a JSON { url } body and queues exactly one pending paper entry', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-url-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: paperConverter });

    const res = await app.request('/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${base}/paper.pdf` }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.converting).toBe(true);

    await until(() => readQueue(vault)[0]?.status === 'pending');
    const queue = readQueue(vault);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      book: 'Fixture Paper Title', title: 'Fixture Paper Title', status: 'pending',
      chapter: 'raw/uploads/fixture-paper-title/paper.md',
    });
  });

  it('defaults JSON url ingests to paper mode even with many headings (no chapter split)', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-url-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: paperConverter });
    await app.request('/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${base}/paper.pdf` }),
    });
    await until(() => readQueue(vault)[0]?.status === 'pending');
    expect(readQueue(vault)).toHaveLength(1);
  });

  it('rejects a bad content-type download with 400', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-url-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: paperConverter });

    const res = await app.request('/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${base}/notapaper` }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/content-type/i);
    expect(readQueue(vault)).toHaveLength(0);
  });

  it('rejects a JSON body with no url with 400', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-url-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: paperConverter });
    const res = await app.request('/api/ingest', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/ingest/repo (B2c)', () => {
  it('rejects a missing "source" field with 400', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-repo-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault));
    const res = await app.request('/api/ingest/repo', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/"source"/);
  });

  it('rejects a source that derives an unsafe name with 400 (path-traversal guard)', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-repo-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault));
    const res = await app.request('/api/ingest/repo', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'https://github.com/foo/bar.baz.git' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/could not derive a safe name/);
  });

  it('rejects a nonexistent local path with 400', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-repo-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault));
    const res = await app.request('/api/ingest/repo', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: '/definitely/does/not/exist-xyz' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not exist/);
  });

  it('a valid local path is accepted and queues a repo placeholder (injected fakes, no real subprocess)', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-repo-'));
    const repoDir = mkdtempSync(join(tmpdir(), 'lwh-ingest-route-repo-src-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), {
      ingestRepoDeps: { miner: async () => ({ candidates: 0, passed: [], rejected: [] }) },
    });
    const res = await app.request('/api/ingest/repo', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: repoDir }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ingesting).toBe(true);
    await until(() => readQueue(vault).some((e) => e.mode === 'repo' && e.book === body.name));
  });
});

// The audit typed a local notes file's path into Add material; it fell through to the repo route,
// which rejected the ".md" extension and told the learner to "rename the repo". A JSON {path}
// body now sends a local file through the same conversion pipeline as an upload.
describe('POST /api/ingest — local file by path', () => {
  it('converts an existing file and 400s a missing one honestly', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-path-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: fakeConverter });

    const dir = mkdtempSync(join(tmpdir(), 'lwh-notes-'));
    const notes = join(dir, 'SGD Notes.md');
    writeFileSync(notes, '# sgd\nminibatches.');
    const ok = await app.request('/api/ingest', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: notes }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ book: 'SGD Notes', converting: true });

    const missing = await app.request('/api/ingest', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: join(dir, 'nope.md') }),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/no file at/);
  });
});
