import { Hono } from 'hono';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { HarnessConfig } from './config.js';
import type { Converter } from './convert.js';
import {
  buildReadingList, indexedBylineFor, rememberIndexedByline,
  type AuthorAffinityRow, type CurateDeps,
} from './curate.js';
import { downloadToTemp } from './download.js';
import { findCanonicalPapers } from './frontierResearch.js';
import { searchVideos } from './videoSearch.js';
import { compileNext, ensureCompileDrain, readQueue, renameBook, startConversion } from './ingest.js';
import { updateQueue } from './queueStore.js';
import { ingestRepo, type IngestRepoDeps } from './ingestRepo.js';
import { deleteLinkDirectory, readLinkDirectories } from './linkList.js';
import { readSources } from './provenance.js';
import { fetchVideoTranscript, isVideoUrl, type VideoIngestDeps } from './videoIngest.js';
import type { ChatModel } from './llm/index.js';
import type { Engram } from './mcp.js';

export function buildIngestRoutes(
  lw: Engram, cfg: HarnessConfig,
  deps: {
    converter?: Converter; model?: ChatModel; fetchImpl?: typeof fetch;
    ingestRepoDeps?: IngestRepoDeps; videoDeps?: VideoIngestDeps;
    /** Curation seams — tests inject all three so no suite needs Crossref, yt-dlp, or a live MCP. */
    curateDeps?: Partial<CurateDeps>;
  } = {},
) {
  const app = new Hono();

  // PDFs can take minutes to convert (marker) — intentionally no timeout here; the client just
  // awaits the fetch.
  app.post('/api/ingest', async (c) => {
    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('application/json')) {
      // `authors` is the CLAIM channel: who the caller (in practice, a model that found this link)
      // says made the material. It is recorded as `claimed` and never outranks what the artifact's
      // own platform reports — see provenance.ts's reconcileAttribution.
      const body = await c.req.json().catch(() => null) as {
        url?: string; path?: string; mode?: 'book' | 'paper'; authors?: string[];
      } | null;
      const claimed = Array.isArray(body?.authors) ? body.authors.filter((a) => typeof a === 'string') : undefined;

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
          // A file on disk reports no byline of its own; whatever the caller claimed stands
          // as unverified rather than being upgraded by having reached the server.
          provenance: { origin: { kind: 'file' }, claimed },
        }));
      }
      if (!body?.url) return c.json({ error: 'JSON body requires a "url" or "path" field' }, 400);

      // A video URL through the SAME door as papers and books (single Add material entry point —
      // a product rule, not an accident): its captions become a timestamped transcript, which is
      // ordinary markdown from here on — paper mode, source reader, select-to-ask, all of it.
      if (isVideoUrl(body.url)) {
        try {
          const { title, channel, markdown } = await fetchVideoTranscript(body.url, deps.videoDeps);
          const tmpDirV = mkdtempSync(join(tmpdir(), 'lwh-video-'));
          const mdPath = join(tmpDirV, 'transcript.md');
          writeFileSync(mdPath, markdown);
          return c.json(startConversion(lw, cfg, mdPath, {
            converter: deps.converter, mode: 'paper', title, model: deps.model, sourceUrl: body.url,
            cleanupInputDir: tmpDirV,
            // yt-dlp read the channel off THIS url's own page — that is the platform's report of
            // who published it, so it wins over any `authors` the caller claimed, and a
            // disagreement is written into the record and shown in the Library.
            provenance: {
              origin: { kind: 'video', url: body.url, platform: 'YouTube' },
              reported: channel ? [channel] : undefined,
              claimed,
            },
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
        // An HTML source reports its own <title>; without it a saved article lands in the Library
        // named "page" (the temp file) or after a URL slug that is often just an id.
        ...(downloaded.title ? { title: downloaded.title } : {}),
        cleanupInputDir: dirname(downloaded.path),
        // A downloaded PDF carries no machine-readable byline this pipeline reads (the converted
        // text does, but only a model would be reading it — which is the claim side, not the
        // reported side), so nothing here is `reported`.
        provenance: {
          origin: { kind: 'url', url: body.url },
          claimed,
          // Never from the request body: only a URL this server itself looked up in an index.
          reported: indexedBylineFor(body.url),
        },
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
    const result = startConversion(lw, cfg, tmpPath, {
      converter: deps.converter, model: deps.model, cleanupInputDir: tmpDir,
      provenance: { origin: { kind: 'file' } },
    });
    return c.json(result);
  });

  /**
   * "Who should I read about X?" — a ranked list of human artifacts and the people behind them.
   *
   * It lives beside the ingest doors because that is where it ends: every row is a url the learner
   * hands straight back to POST /api/ingest. No model is involved on either side of this route —
   * curate.ts is arithmetic over Crossref and yt-dlp results — so it answers the same under a weak
   * local model as under a frontier one.
   */
  app.post('/api/curate', async (c) => {
    const body = await c.req.json().catch(() => null) as { topic?: string } | null;
    const topic = typeof body?.topic === 'string' ? body.topic.trim() : '';
    if (!topic) return c.json({ error: 'JSON body requires a non-empty "topic" field' }, 400);
    const cd = deps.curateDeps ?? {};
    const list = await buildReadingList(topic, {
      findCanonicalPapers: cd.findCanonicalPapers
        ?? ((t) => findCanonicalPapers(t, deps.fetchImpl ?? fetch)),
      searchVideos: cd.searchVideos ?? searchVideos,
      authorAffinity: cd.authorAffinity ?? (async () => {
        const res = await lw.call('author_affinity', { student: cfg.student }) as
          { authors?: AuthorAffinityRow[] };
        return res?.authors ?? [];
      }),
    });
    // The server asked an index for each of these URLs and the index answered — so a later ingest
    // of that exact URL can treat the byline as reported-by-the-artifact rather than claimed by
    // whoever posts the ingest. See curate.ts's note on why this is a map and not a request field.
    for (const rec of list.recommendations) rememberIndexedByline(rec.url, rec.by);
    return c.json(list);
  });

  app.get('/api/ingest/queue', (c) => c.json(readQueue(cfg.vault)));

  /** Who each ingested source is by, and whether that byline was verified against the artifact or
   * merely claimed by a model — the Library shows the difference rather than flattening it. */
  app.get('/api/sources', (c) => c.json(readSources(cfg.vault)));

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

  /**
   * Ask a failed chapter to compile again. The source markdown never left `raw/uploads/`, so a
   * failure whose CAUSE has since been fixed — a corrected model id, a provider quirk the adapter
   * now handles — is one flip away from succeeding. Without this the only recovery was dismissing
   * every failed row and re-ingesting the whole book; 54 chapters were once stranded that way by a
   * single provider refusal.
   *
   * Only failed rows: retrying a `done` chapter would compile its pages a second time, and a
   * pending/converting one is already owed work.
   */
  app.post('/api/ingest/entry/retry', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const chapter = String(body?.chapter ?? '');
    if (!chapter) return c.json({ error: 'chapter is required' }, 400);
    const entry = readQueue(cfg.vault).find((e) => e.chapter === chapter);
    if (!entry) return c.json({ error: 'no such ledger entry' }, 404);
    if (entry.status !== 'error' && entry.status !== 'convert-error') {
      return c.json({ error: `only failed rows can be retried — this one is ${entry.status}` }, 409);
    }
    // Targeted write inside the mutex (queueStore.ts's rule): re-find by chapter identity rather
    // than writing back an array read before the await above.
    await updateQueue(cfg.vault, (entries) => {
      const live = entries.find((e) => e.chapter === chapter);
      if (!live) return;
      live.status = 'pending';
      // The old failure must not ride along into the retry — a row showing last run's error while
      // queued reads as "failed again" the moment the learner glances at it.
      delete live.error;
      delete live.phase;
    });
    ensureCompileDrain(lw, cfg);
    return c.json({ retrying: chapter });
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

  // Link directories (linkList.ts): catalogues written by the repo docs pass when a doc file is
  // an awesome-list-shaped directory of external links. Browsing lives in the Library; ingesting
  // an individual link goes back through POST /api/ingest {url} — the same single door as every
  // other URL, so a video link still becomes a transcript and an article a paper.
  app.get('/api/linklists', (c) => c.json(readLinkDirectories(cfg.vault)));

  app.delete('/api/linklists', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body?.name ?? '');
    if (!name) return c.json({ error: 'name is required' }, 400);
    if (!deleteLinkDirectory(cfg.vault, name)) return c.json({ error: `no link directory named ${JSON.stringify(name)}` }, 404);
    return c.json({ dismissed: name });
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
