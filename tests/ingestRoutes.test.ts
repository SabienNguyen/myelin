import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIngestRoutes } from '../src/server/ingestRoutes.js';
import { streamModel } from './mockModel.js';
import { readQueue } from '../src/server/ingest.js';
import { writeQueue } from '../src/server/queueStore.js';
import { saveLinkDirectory } from '../src/server/linkList.js';
import type { HarnessConfig } from '../src/server/config.js';
import type { Converter } from '../src/server/convert.js';
import {
  indexedBylineFor as indexedBylineForTest, resetIndexedBylines, type CurateDeps,
} from '../src/server/curate.js';
import { reconcileAttribution as reconcileFor } from '../src/server/provenance.js';

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
  return { listSlugs: async () => [] as string[], tools: async () => [] } as any;
}

function noToolModel() {
  return streamModel(() => ({ text: 'nothing to do' }));
}

function cfgFor(vault: string): HarnessConfig {
  return { vault, student: 'kid', models: {} } as unknown as HarnessConfig;
}

describe('link-directory routes', () => {
  it('GET /api/linklists returns stored catalogues; DELETE dismisses one', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-linklist-routes-'));
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: fakeConverter });

    expect(await (await app.request('/api/linklists')).json()).toEqual([]);

    const entry = {
      name: 'awesome-x', source: 'https://github.com/y/awesome-x', file: 'README.md',
      savedAt: '2026-07-29T00:00:00.000Z',
      sections: [{ title: 'Reads', links: [{ title: 't', url: 'https://e.com/1', note: 'n' }] }],
      total: 1, omitted: 0,
    };
    saveLinkDirectory(vault, entry);
    expect(await (await app.request('/api/linklists')).json()).toEqual([entry]);

    const del = await app.request('/api/linklists', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'awesome-x' }),
    });
    expect(del.status).toBe(200);
    expect(await (await app.request('/api/linklists')).json()).toEqual([]);

    const missing = await app.request('/api/linklists', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'awesome-x' }),
    });
    expect(missing.status).toBe(404);
  });
});

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
        // text/html is a SUPPORTED source now — it extracts to markdown and compiles like any
        // other document — so this case needs a type the pipeline genuinely cannot read.
        res.setHeader('content-type', 'image/png');
        res.end('not a document');
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
      ingestRepoDeps: { builtinMiner: async () => ({ candidates: 0, qualified: 0, authored: [], rejected: [] }) },
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

// "Who should I read?" — the curation door. The list itself is pinned in tests/curate.test.ts;
// these pin the route's contract: a named 400, and that engram being down costs the affinity
// bonus rather than the whole answer.
describe('POST /api/curate', () => {
  const curateApp = (curateDeps: Partial<CurateDeps>, lw = fakeLw()) =>
    buildIngestRoutes(lw, cfgFor(mkdtempSync(join(tmpdir(), 'lwh-curate-'))), { curateDeps });

  const post = (app: ReturnType<typeof buildIngestRoutes>, body: unknown) => app.request('/api/curate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  // THE property that keeps `verified` meaningful. A byline is verified only when the SERVER
  // obtained it from an index for that exact URL — never because a caller said so. Curating first
  // is what earns it; posting the same authors without curating must not.
  it('a curated URL ingests as verified, but the same authors posted cold stay claimed', async () => {
    resetIndexedBylines();
    const vault = mkdtempSync(join(tmpdir(), 'lwh-curate-prov-'));
    const cfg = cfgFor(vault);
    const paper = {
      title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], date: '2017-06-12',
      source: 'Crossref' as const, url: 'https://doi.org/10/aiayn', citations: 4182,
    };
    const app = buildIngestRoutes(fakeLw(), cfg, {
      curateDeps: { findCanonicalPapers: async () => ({ papers: [paper], sourceErrors: [] }),
        searchVideos: async () => [] },
    });

    // Cold post first: nothing has been indexed for this URL, so the byline is only a claim.
    const cold = reconcileFor(['Ashish Vaswani'], undefined);
    expect(cold.attribution).toBe('claimed');

    // Curate — the server itself asks the index and remembers what it was told for that URL.
    await post(app, { topic: 'transformers' });
    const warm = reconcileFor(['Ashish Vaswani'], indexedBylineForTest(paper.url));
    expect(warm.attribution).toBe('verified');
    expect(warm.authors).toEqual(['Ashish Vaswani']);

    // And a URL the server never indexed stays unverifiable no matter what a caller sends.
    expect(indexedBylineForTest('https://example.com/never-curated')).toBeUndefined();
  });

  it('names the missing field on an empty or absent topic', async () => {
    const app = curateApp({});
    for (const body of [{}, { topic: '   ' }, { topic: 42 }]) {
      const res = await post(app, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/"topic"/);
    }
  });

  it('returns the ranked list for a topic', async () => {
    const app = curateApp({
      findCanonicalPapers: async () => ({
        papers: [{
          title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], date: '2017-06-12',
          source: 'Crossref' as const, url: 'https://doi.org/10/aiayn', citations: 4182,
        }],
        sourceErrors: [],
      }),
      searchVideos: async () => [],
      authorAffinity: async () => [],
    });
    const res = await post(app, { topic: ' transformers ' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.topic).toBe('transformers');
    expect(body.recommendations).toEqual([{
      kind: 'paper', title: 'Attention Is All You Need', by: ['Ashish Vaswani'],
      url: 'https://doi.org/10/aiayn', why: ['4,182 citations'], knownAuthor: false,
    }]);
  });

  it('engram being down degrades to knownAuthor:false — it never 500s the request', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deadLw = { ...fakeLw(), call: async () => { throw new Error('mcp transport closed'); } } as any;
    const app = curateApp({
      findCanonicalPapers: async () => ({
        papers: [{
          title: 'A Paper', authors: ['Ada Lovelace'], date: '2011-01-01',
          source: 'Crossref' as const, url: 'https://doi.org/10/p', citations: 7,
        }],
        sourceErrors: [],
      }),
      searchVideos: async () => [],
    }, deadLw);

    const res = await post(app, { topic: 'memory' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recommendations[0].knownAuthor).toBe(false);
    expect(body.sourceErrors).toEqual([]);
    err.mockRestore();
  });

  it('reads real affinity through engram author_affinity for cfg.student', async () => {
    const calls: any[] = [];
    const lw = {
      ...fakeLw(),
      call: async (name: string, args: any) => {
        calls.push([name, args]);
        return { authors: [{ author: 'Ada Lovelace', provenEvidence: 6, pages: 2 }] };
      },
    } as any;
    const app = curateApp({
      findCanonicalPapers: async () => ({
        papers: [{
          title: 'A Paper', authors: ['Ada Lovelace'], date: '2011-01-01',
          source: 'Crossref' as const, url: 'https://doi.org/10/p', citations: 7,
        }],
        sourceErrors: [],
      }),
      searchVideos: async () => [],
    }, lw);

    const body = await (await post(app, { topic: 'memory' })).json();
    expect(calls).toEqual([['author_affinity', { student: 'kid' }]]);
    expect(body.recommendations[0].knownAuthor).toBe(true);
    expect(body.recommendations[0].why[0]).toMatch(/you have proven 6 evidence entries/);
  });
});

/**
 * Retry: a failed chapter's source markdown is still on disk, so a failure whose CAUSE has been
 * fixed (a bad model id corrected, a provider quirk handled) should be one click from compiling —
 * not a dismiss-and-re-ingest-the-whole-book. Observed live: 54 chapters stranded in `error` after
 * a provider refusal, every raw file intact, and no way in the app to ask for another go.
 */
describe('POST /api/ingest/entry/retry', () => {
  const failedVault = () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-retry-'));
    writeQueue(vault, [
      { book: 'B', chapter: 'raw/uploads/b/ch-01.md', title: 'Ch 1', status: 'error', error: 'boom', phase: 'part 1: verbatim' },
      { book: 'B', chapter: 'raw/uploads/b/ch-02.md', title: 'Ch 2', status: 'done' },
      { book: 'B', chapter: 'raw/uploads/b/ch-03.md', title: 'Ch 3', status: 'pending' },
    ] as any);
    return vault;
  };
  const retry = (app: any, chapter: string) => app.request('/api/ingest/entry/retry', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chapter }),
  });

  it('flips a failed row back to pending and clears its stale error and phase', async () => {
    const vault = failedVault();
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: fakeConverter, model: noToolModel() } as any);
    const res = await retry(app, 'raw/uploads/b/ch-01.md');
    expect(res.status).toBe(200);
    const row = readQueue(vault).find((e) => e.chapter === 'raw/uploads/b/ch-01.md')!;
    expect(row.status).toBe('pending');
    expect(row.error).toBeUndefined();   // a retried row must not still show the old failure
    expect(row.phase).toBeUndefined();
  });

  it('refuses a row that did not fail — retrying a finished chapter would duplicate its pages', async () => {
    const vault = failedVault();
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: fakeConverter, model: noToolModel() } as any);
    expect((await retry(app, 'raw/uploads/b/ch-02.md')).status).toBe(409);
    expect((await retry(app, 'raw/uploads/b/ch-03.md')).status).toBe(409);
    expect(readQueue(vault).find((e) => e.chapter === 'raw/uploads/b/ch-02.md')!.status).toBe('done');
  });

  it('404s an unknown chapter and 400s a missing one', async () => {
    const vault = failedVault();
    const app = buildIngestRoutes(fakeLw(), cfgFor(vault), { converter: fakeConverter, model: noToolModel() } as any);
    expect((await retry(app, 'raw/uploads/b/nope.md')).status).toBe(404);
    expect((await retry(app, '')).status).toBe(400);
  });
});
