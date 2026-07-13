import type { LanguageModel } from 'ai';
import { Hono } from 'hono';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessConfig } from './config.js';
import type { Converter } from './convert.js';
import { compileNext, ingestBook, readQueue } from './ingest.js';
import type { Loreweaver } from './mcp.js';

export function buildIngestRoutes(
  lw: Loreweaver, cfg: HarnessConfig, deps: { converter?: Converter; model?: LanguageModel } = {},
) {
  const app = new Hono();

  // PDFs can take minutes to convert (marker) — intentionally no timeout here; the client just
  // awaits the fetch.
  app.post('/api/ingest', async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: 'multipart field "file" is required' }, 400);
    const tmpDir = mkdtempSync(join(tmpdir(), 'lwh-upload-'));
    const tmpPath = join(tmpDir, file.name);
    writeFileSync(tmpPath, Buffer.from(await file.arrayBuffer()));
    const result = await ingestBook(cfg, tmpPath, { converter: deps.converter });
    return c.json(result);
  });

  app.get('/api/ingest/queue', (c) => c.json(readQueue(cfg.vault)));

  app.post('/api/ingest/compile', async (c) => {
    const { n } = await c.req.json().catch(() => ({ n: undefined }) as { n?: number });
    const summary = await compileNext(lw, cfg, n ?? 1, { model: deps.model });
    return c.json(summary);
  });

  return app;
}
