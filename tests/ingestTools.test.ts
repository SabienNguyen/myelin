import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIngestTools } from '../src/server/ingestTools.js';
import { readQueue } from '../src/server/ingest.js';
import type { HarnessConfig } from '../src/server/config.js';
import type { Converter } from '../src/server/convert.js';

// ingest_paper fires a background compileNext(lw, cfg, 1) it never awaits. Point cfg.models.compile
// at an unreachable local ollama model (not the real network) so that background call fails fast
// (ECONNREFUSED on localhost) instead of hitting the internet or hanging the test process.
function cfgFor(vault: string): HarnessConfig {
  return {
    vault, student: 'kid',
    models: { compile: { model: 'ollama:unreachable-test-model' } },
  } as unknown as HarnessConfig;
}

function fakeLw() {
  return { listSlugs: async () => [] as string[], tools: async () => ({}) } as any;
}

const fakeConverter: Converter = async () => ({ markdown: '# A Nice Paper\nAbstract text here.' });

describe('ingest_paper tool', () => {
  it('downloads, queues a paper entry, and returns { queued, compiling: true } without awaiting compile', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-tool-'));
    const fakeDownload = vi.fn(async (_url: string) => ({ path: '/fake/paper.pdf', contentType: 'application/pdf' }));
    const tools = buildIngestTools(fakeLw(), cfgFor(vault), { download: fakeDownload, converter: fakeConverter });

    const out = await (tools.ingest_paper as any).execute({ url: 'https://arxiv.org/pdf/2401.12345' }, {});
    expect(out).toEqual({ queued: 'A Nice Paper', compiling: true });
    expect(fakeDownload).toHaveBeenCalledWith('https://arxiv.org/pdf/2401.12345');

    const queue = readQueue(vault);
    expect(queue).toHaveLength(1);
    // compileNext runs synchronously up to its first await (inside the batch loop, before
    // `await lw.listSlugs()`) — so by the time execute() resolves, the fire-and-forget kick has
    // already flipped the entry to 'compiling' on disk. This asserts the kick really fired.
    expect(queue[0]).toMatchObject({ book: 'A Nice Paper', title: 'A Nice Paper', status: 'compiling' });
  });

  it('uses the optional title hint to name the queued paper, overriding H1 detection', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-tool-'));
    const fakeDownload = async () => ({ path: '/fake/paper.pdf', contentType: 'application/pdf' });
    const tools = buildIngestTools(fakeLw(), cfgFor(vault), { download: fakeDownload, converter: fakeConverter });

    const out = await (tools.ingest_paper as any).execute(
      { url: 'https://example.com/paper.pdf', title: 'Custom Title' }, {},
    );
    expect(out).toEqual({ queued: 'Custom Title', compiling: true });
    expect(readQueue(vault)[0].title).toBe('Custom Title');
  });

  it('returns a structured error and never throws when download fails', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-tool-'));
    const fakeDownload = async () => { throw new Error('unsupported content-type "text/html" for download'); };
    const tools = buildIngestTools(fakeLw(), cfgFor(vault), { download: fakeDownload, converter: fakeConverter });

    const out = await (tools.ingest_paper as any).execute({ url: 'https://example.com/notapaper' }, {});
    expect(out).toEqual({ error: expect.stringMatching(/unsupported content-type/) });
    expect(readQueue(vault)).toHaveLength(0);
  });

  it('returns a structured error and never throws when ingestBook (conversion) fails', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-tool-'));
    const fakeDownload = async () => ({ path: '/fake/paper.pdf', contentType: 'application/pdf' });
    const brokenConverter: Converter = async () => { throw new Error('conversion exploded'); };
    const tools = buildIngestTools(fakeLw(), cfgFor(vault), { download: fakeDownload, converter: brokenConverter });

    const out = await (tools.ingest_paper as any).execute({ url: 'https://example.com/paper.pdf' }, {});
    expect(out).toEqual({ error: expect.stringMatching(/conversion exploded/) });
  });
});
