import type { LanguageModel } from 'ai';
import { Hono } from 'hono';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessConfig } from './config.js';
import type { Converter } from './convert.js';
import { downloadToTemp } from './download.js';
import { compileNext, readQueue, renameBook, startConversion } from './ingest.js';
import type { Loreweaver } from './mcp.js';

export function buildIngestRoutes(
  lw: Loreweaver, cfg: HarnessConfig,
  deps: { converter?: Converter; model?: LanguageModel; fetchImpl?: typeof fetch } = {},
) {
  const app = new Hono();

  // PDFs can take minutes to convert (marker) — intentionally no timeout here; the client just
  // awaits the fetch.
  app.post('/api/ingest', async (c) => {
    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('application/json')) {
      const body = await c.req.json().catch(() => null) as { url?: string; mode?: 'book' | 'paper' } | null;
      if (!body?.url) return c.json({ error: 'JSON body requires a "url" field' }, 400);
      let downloaded: Awaited<ReturnType<typeof downloadToTemp>>;
      try {
        downloaded = await downloadToTemp(body.url, { fetchImpl: deps.fetchImpl });
      } catch (e: any) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
      // URL ingests default to paper mode — arXiv/journal links are single-document sources, not
      // multi-chapter books. Conversion runs in the background; the Library shows a
      // reload-safe 'converting' placeholder immediately.
      const result = startConversion(cfg, downloaded.path, { converter: deps.converter, mode: body.mode ?? 'paper' });
      return c.json(result);
    }

    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: 'multipart field "file" is required' }, 400);
    const tmpDir = mkdtempSync(join(tmpdir(), 'lwh-upload-'));
    const tmpPath = join(tmpDir, file.name);
    writeFileSync(tmpPath, Buffer.from(await file.arrayBuffer()));
    const result = startConversion(cfg, tmpPath, { converter: deps.converter });
    return c.json(result);
  });

  app.get('/api/ingest/queue', (c) => c.json(readQueue(cfg.vault)));

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
    const { n } = await c.req.json().catch(() => ({ n: undefined }) as { n?: number });
    const summary = await compileNext(lw, cfg, n ?? 1, { model: deps.model });
    return c.json(summary);
  });

  return app;
}
