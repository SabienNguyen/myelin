import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Loreweaver } from '../src/server/mcp.js';
import { seedPatternPages } from '../src/server/seedPatternPages.js';
import type { HarnessConfig } from '../src/server/config.js';

const LW_REPO = `${process.env.HOME}/Dev/personal/loreweaver`;
let lw: Loreweaver;
let vault: string;
let cfg: HarnessConfig;

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), 'lwh-seed-vault-'));
  mkdirSync(join(vault, 'pages'), { recursive: true });
  cfg = {
    vault, student: 'testkid',
    gap: { url: 'http://localhost:4930' },
    loreweaver: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
  } as HarnessConfig;
  lw = await Loreweaver.connect(cfg);
}, 30_000);

afterAll(async () => { await lw.close(); });

describe('seedPatternPages', () => {
  it('seeds stream-consumer when missing', async () => {
    expect(await lw.listSlugs()).not.toContain('stream-consumer');
    await seedPatternPages(lw, cfg);
    expect(await lw.listSlugs()).toContain('stream-consumer');
    const { page } = await lw.call('read_page', { slug: 'stream-consumer' });
    expect(page.meta.title).toBe('Consuming SSE token streams');
    expect(page.meta.status).toBe('stub');
    expect(page.meta.sources).toContain('the-gap artifact stream-consumer');
    expect(page.domain).toBe('programming');
  });

  it('no-ops when the page already exists — even after it grows past the stub', async () => {
    // Simulate the page having grown up (e.g. the tutor filled it in, status promoted).
    await lw.call('write_page', {
      slug: 'stream-consumer', title: 'Consuming SSE token streams (expanded)',
      body: 'a real lesson now', status: 'solid',
    });
    await seedPatternPages(lw, cfg);
    const { page } = await lw.call('read_page', { slug: 'stream-consumer' });
    // The seed must NOT have clobbered the grown page back to the stub.
    expect(page.meta.title).toBe('Consuming SSE token streams (expanded)');
    expect(page.meta.status).toBe('solid');
  });

  it('no-ops entirely when cfg.gap is absent', async () => {
    const vault2 = mkdtempSync(join(tmpdir(), 'lwh-seed-vault2-'));
    mkdirSync(join(vault2, 'pages'), { recursive: true });
    const cfgNoGap = {
      vault: vault2, student: 'testkid',
      loreweaver: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
    } as HarnessConfig;
    const lw2 = await Loreweaver.connect(cfgNoGap);
    try {
      await seedPatternPages(lw2, cfgNoGap);
      expect(await lw2.listSlugs()).toEqual([]);
    } finally {
      await lw2.close();
    }
  }, 30_000);
});
