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
  return { listSlugs: async () => [] as string[], tools: async () => [] } as any;
}

/** buildIngestTools returns LoopTool[]; this resolves ingest_paper's execute for the drives below. */
const ingestPaper = (tools: ReturnType<typeof buildIngestTools>) =>
  tools.find((t) => t.name === 'ingest_paper')!.execute!;

const fakeConverter: Converter = async () => ({ markdown: '# A Nice Paper\nAbstract text here.' });

/** Poll until fn() is truthy — conversion + compile-kick now run in the background. */
async function until<T>(fn: () => T, ms = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('until(): timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('ingest_paper tool', () => {
  it('returns immediately with a converting placeholder; compile kicks after conversion', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-tool-'));
    const fakeDownload = vi.fn(async (_url: string) => ({ path: '/fake/paper.pdf', contentType: 'application/pdf' }));
    const tools = buildIngestTools(fakeLw(), cfgFor(vault), { download: fakeDownload, converter: fakeConverter });

    const out = await ingestPaper(tools)({ url: 'https://arxiv.org/pdf/2401.12345' });
    expect(out).toEqual({ queued: 'paper', converting: true, compiling: 'starts after conversion' });
    expect(fakeDownload).toHaveBeenCalledWith('https://arxiv.org/pdf/2401.12345');
    // Placeholder is on disk instantly (reload-safe visibility)…
    expect(readQueue(vault)[0]).toMatchObject({ status: 'converting' });
    // …then background conversion replaces it and the onComplete kick flips it to compiling.
    const entry = await until(() => {
      const q = readQueue(vault);
      return q[0]?.book === 'A Nice Paper' && q[0].status !== 'converting' ? q[0] : null;
    });
    expect(entry!).toMatchObject({ book: 'A Nice Paper', title: 'A Nice Paper' });
    expect(['pending', 'compiling', 'error']).toContain(entry!.status); // compile kick raced in
  });

  it('uses the optional title hint to name the queued paper, overriding H1 detection', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-tool-'));
    const fakeDownload = async () => ({ path: '/fake/paper.pdf', contentType: 'application/pdf' });
    const tools = buildIngestTools(fakeLw(), cfgFor(vault), { download: fakeDownload, converter: fakeConverter });

    const out = await ingestPaper(tools)({ url: 'https://example.com/paper.pdf', title: 'Custom Title' });
    expect(out).toEqual({ queued: 'Custom Title', converting: true, compiling: 'starts after conversion' });
    await until(() => readQueue(vault)[0]?.title === 'Custom Title' && readQueue(vault)[0].status !== 'converting');
  });

  it('returns a structured error and never throws when download fails', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-tool-'));
    const fakeDownload = async () => { throw new Error('unsupported content-type "text/html" for download'); };
    const tools = buildIngestTools(fakeLw(), cfgFor(vault), { download: fakeDownload, converter: fakeConverter });

    const out = await ingestPaper(tools)({ url: 'https://example.com/notapaper' });
    expect(out).toEqual({ error: expect.stringMatching(/unsupported content-type/) });
    expect(readQueue(vault)).toHaveLength(0);
  });

  it('returns a structured error and never throws when ingestBook (conversion) fails', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-tool-'));
    const fakeDownload = async () => ({ path: '/fake/paper.pdf', contentType: 'application/pdf' });
    const brokenConverter: Converter = async () => { throw new Error('conversion exploded'); };
    const tools = buildIngestTools(fakeLw(), cfgFor(vault), { download: fakeDownload, converter: brokenConverter });

    const out = await ingestPaper(tools)({ url: 'https://example.com/paper.pdf' });
    // Conversion failures now surface in the LEDGER (convert-error), not the tool result —
    // the tool returns before conversion runs.
    expect(out).toMatchObject({ converting: true });
    const entry = await until(() => {
      const q = readQueue(vault);
      return q[0]?.status === 'convert-error' ? q[0] : null;
    });
    expect(entry!.error).toMatch(/conversion exploded/);
  });
});
