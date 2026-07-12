import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Loreweaver } from '../src/server/mcp.js';
import type { HarnessConfig } from '../src/server/config.js';

const LW_REPO = `${process.env.HOME}/Dev/personal/loreweaver`;
let lw: Loreweaver;
let vault: string;

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), 'lwh-vault-'));
  mkdirSync(join(vault, 'pages'), { recursive: true });
  writeFileSync(join(vault, 'pages', 'derivatives.md'),
    '---\ntitle: Derivatives\ndifficulty: 1\nstatus: solid\n---\nrates of change');
  const cfg = {
    vault, student: 'testkid',
    loreweaver: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
  } as HarnessConfig;
  lw = await Loreweaver.connect(cfg);
}, 30_000);

afterAll(async () => { await lw.close(); });

describe('Loreweaver client', () => {
  it('lists slugs by glob without parsing', async () => {
    expect(await lw.listSlugs()).toEqual(['derivatives']);
  });
  it('calls read_page and parses JSON', async () => {
    const page = await lw.call('read_page', { slug: 'derivatives' });
    expect(page.page.meta.title).toBe('Derivatives');
  });
  it('exposes tools for the agent loop', async () => {
    const tools = await lw.tools();
    expect(Object.keys(tools)).toContain('record_evidence');
  });
  it('throws a readable error on isError results', async () => {
    await expect(lw.call('read_page', { slug: 'nope' })).rejects.toThrow();
  });
}, 30_000);

it('GET /api/graph returns nodes with mastery', async () => {
  const { buildRestRoutes } = await import('../src/server/restRoutes.js');
  const app = buildRestRoutes(lw, { student: 'testkid' } as any);
  const res = await app.request('/api/graph');
  const body = await res.json();
  expect(body.nodes[0].slug).toBe('derivatives');
  expect(body.nodes[0].mastery).toBeNull(); // no evidence yet
});
