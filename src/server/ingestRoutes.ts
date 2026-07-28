import type { LanguageModel } from 'ai';
import { Hono } from 'hono';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { HarnessConfig } from './config.js';
import type { Converter } from './convert.js';
import { downloadToTemp } from './download.js';
import { compileNext, readQueue, renameBook, startConversion } from './ingest.js';
import { updateQueue } from './queueStore.js';
import { ingestRepo, type IngestRepoDeps } from './ingestRepo.js';
import { fetchVideoTranscript, isVideoUrl, type VideoIngestDeps } from './videoIngest.js';
import type { Loreweaver } from './mcp.js';

export function buildIngestRoutes(
  lw: Loreweaver, cfg: HarnessConfig,
  deps: {
    converter?: Converter; model?: LanguageModel; fetchImpl?: typeof fetch;
    ingestRepoDeps?: IngestRepoDeps; videoDeps?: VideoIngestDeps;
  } = {},
) {
  const app = new Hono();

  // PDFs can take minutes to convert (marker) — intentionally no timeout here; the client just
  // awaits the fetch.
  app.post('/api/ingest', async (c) => {
    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('application/json')) {
      const body = await c.req.json().catch(() => null) as { url?: string; path?: string; mode?: 'book' | 'paper' } | null;

      // A LOCAL file by path — the audit typed a notes file's path into Add material and it fell
      // through to the repo route, which choked deriving a repo name from "sgd-notes.md" and then
      // told the learner to "rename the repo". The server reading a learner-supplied path is
      // already this app's trust model (repo ingest does it for local directories); a single
      // file goes through the exact pipeline an uploaded file does.
      if (body?.path && !body.url) {
        const p = body.path.trim();
        if (!existsSync(p) || !statSync(p).isFile()) {
          return c.json({ error: `no file at ${JSON.stringify(p)} — check the path` }, 400);
        }
        return c.json(startConversion(lw, cfg, p, {
          converter: deps.converter, mode: body.mode, model: deps.model,
        }));
      }
      if (!body?.url) return c.json({ error: 'JSON body requires a "url" or "path" field' }, 400);

      // A video URL through the SAME door as papers and books (single Add material entry point —
      // a product rule, not an accident): its captions become a timestamped transcript, which is
      // ordinary markdown from here on — paper mode, source reader, select-to-ask, all of it.
      if (isVideoUrl(body.url)) {
        try {
          const { title, markdown } = await fetchVideoTranscript(body.url, deps.videoDeps);
          const tmpDirV = mkdtempSync(join(tmpdir(), 'lwh-video-'));
          const mdPath = join(tmpDirV, 'transcript.md');
          writeFileSync(mdPath, markdown);
          return c.json(startConversion(lw, cfg, mdPath, {
            converter: deps.converter, mode: 'paper', title, model: deps.model, sourceUrl: body.url,
          }));
        } catch (e: any) {
          return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      let downloaded: Awaited<ReturnType<typeof downloadToTemp>>;
      try {
        downloaded = await downloadToTemp(body.url, { fetchImpl: deps.fetchImpl });
      } catch (e: any) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
      // URL ingests default to paper mode — arXiv/journal links are single-document sources, not
      // multi-chapter books. Conversion runs in the background; the Library shows a
      // reload-safe 'converting' placeholder immediately.
      const result = startConversion(lw, cfg, downloaded.path, {
        converter: deps.converter, mode: body.mode ?? 'paper', model: deps.model, sourceUrl: body.url,
      });
      return c.json(result);
    }

    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: 'multipart field "file" is required' }, 400);
    // file.name is client-controlled. join(tmpDir, "../../etc/x") escapes the temp dir and
    // writeFileSync would then write to an arbitrary path — basename strips every path component,
    // and rejecting the two traversal basenames ("." / "..") that survive it keeps the write inside
    // the fresh temp dir. Same containment the vault's fileWithin and deriveRepoName already enforce
    // for client-supplied names.
    const safeName = basename(file.name);
    if (!safeName || safeName === '.' || safeName === '..') {
      return c.json({ error: 'invalid file name' }, 400);
    }
    const tmpDir = mkdtempSync(join(tmpdir(), 'lwh-upload-'));
    const tmpPath = join(tmpDir, safeName);
    writeFileSync(tmpPath, Buffer.from(await file.arrayBuffer()));
    const result = startConversion(lw, cfg, tmpPath, { converter: deps.converter, model: deps.model });
    return c.json(result);
  });

  app.get('/api/ingest/queue', (c) => c.json(readQueue(cfg.vault)));

  /**
   * Dismiss one finished ledger row. Terminal rows only — a failed repo ingest from weeks ago is
   * history the learner has read and cannot act on further, and until this route existed it sat
   * in the Library forever (the audit found a stale 'mining failed' row confusing the exact
   * person it was written to inform). Pending/converting rows refuse: removing one would orphan
   * work that is still running or still owed.
   */
  app.delete('/api/ingest/entry', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const chapter = String(body?.chapter ?? '');
    if (!chapter) return c.json({ error: 'chapter is required' }, 400);
    const entry = readQueue(cfg.vault).find((e) => e.chapter === chapter);
    if (!entry) return c.json({ error: 'no such ledger entry' }, 404);
    if (entry.status !== 'error' && entry.status !== 'convert-error' && entry.status !== 'done') {
      return c.json({ error: `only finished rows can be dismissed — this one is ${entry.status}` }, 409);
    }
    await updateQueue(cfg.vault, (entries) => entries.filter((e) => e.chapter !== chapter));
    return c.json({ dismissed: chapter });
  });

  // B2c: "Add repo" ingestion — git URL or absolute local path. Name derivation/validation
  // (ingestRepo.ts's deriveRepoName + local-path existence check) happens synchronously before
  // any ledger write, so a bad name or a nonexistent local path 400s immediately rather than
  // queuing a placeholder that would just fail a moment later.
  app.post('/api/ingest/repo', async (c) => {
    const body = await c.req.json().catch(() => null) as { source?: string } | null;
    if (!body?.source?.trim()) {
      return c.json({ error: 'JSON body requires a "source" field (git URL or absolute local path)' }, 400);
    }
    try {
      const result = ingestRepo(lw, cfg, body.source, deps.ingestRepoDeps);
      return c.json(result);
    } catch (e: any) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.patch('/api/ingest/book', async (c) => {
    const body = await c.req.json().catch(() => null) as { book?: string; name?: string } | null;
    if (!body?.book || !body?.name?.trim()) {
      return c.json({ error: 'JSON body requires "book" (current name) and non-empty "name"' }, 400);
    }
    const changed = renameBook(cfg.vault, body.book, body.name);
    if (changed === 0) return c.json({ error: `no queue entries for book "${body.book}"` }, 404);
    return c.json({ renamed: changed });
  });

  app.post('/api/ingest/compile', async (c) => {
    const { n, concurrency } = await c.req.json()
      .catch(() => ({}) as { n?: number; concurrency?: number });
    const summary = await compileNext(lw, cfg, n ?? 1, { model: deps.model, concurrency: concurrency ?? 1 });
    return c.json(summary);
  });

  return app;
}
