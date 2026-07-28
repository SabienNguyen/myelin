import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Loreweaver, isTransportError } from '../src/server/mcp.js';
import type { HarnessConfig } from '../src/server/config.js';
import { LW_REPO } from './lwRepo.js';

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

  // T41: a long auto-compile drain killed the spawned child; call() already respawned once on
  // a transport-shaped error, but tools() proxied the dead client directly and every subsequent
  // chapter errored with "Attempted to send a request from a closed client". These simulate the
  // dead child by closing the real client out from under the instance, then exercise each surface
  // that must recover via a single respawn-and-retry.
  it('recovers call() after the transport dies', async () => {
    await (lw as any).client.close();
    const page = await lw.call('read_page', { slug: 'derivatives' });
    expect(page.page.meta.title).toBe('Derivatives');
  });

  it('recovers tools() after the transport dies', async () => {
    await (lw as any).client.close();
    const tools = await lw.tools();
    expect(Object.keys(tools)).toContain('record_evidence');
    const raw: any = await (tools.read_page as any).execute({ slug: 'derivatives' }, {} as any);
    const parsed = JSON.parse(raw.content[0].text);
    expect(parsed.page.meta.title).toBe('Derivatives');
  });

  it("recovers a previously-fetched tool's execute after the transport dies underneath it", async () => {
    const tools = await lw.tools(); // fetched while the client is alive
    await (lw as any).client.close(); // kill the client the fetched tool's closure was bound to
    const raw: any = await (tools.read_page as any).execute({ slug: 'derivatives' }, {} as any);
    const parsed = JSON.parse(raw.content[0].text);
    expect(parsed.page.meta.title).toBe('Derivatives');
  });
}, 60_000);

describe('isTransportError', () => {
  it('matches the literal message observed in production', () => {
    expect(isTransportError(new Error('Attempted to send a request from a closed client'))).toBe(true);
  });
  it('matches EPIPE, transport, and disconnected too', () => {
    expect(isTransportError(new Error('write EPIPE'))).toBe(true);
    expect(isTransportError(new Error('transport error'))).toBe(true);
    expect(isTransportError(new Error('disconnected from server'))).toBe(true);
  });
  it('does not match unrelated errors', () => {
    expect(isTransportError(new Error('page not found: nope'))).toBe(false);
  });
});

it('GET /api/graph returns nodes with mastery', async () => {
  const { buildRestRoutes } = await import('../src/server/restRoutes.js');
  const app = buildRestRoutes(lw, { student: 'testkid' } as any);
  const res = await app.request('/api/graph');
  const body = await res.json();
  expect(body.nodes[0].slug).toBe('derivatives');
  expect(body.nodes[0].mastery).toBeNull(); // no evidence yet
});

// T43 (misconception lifecycle audit): graph nodes carry mastery — color, decay ring, and the ⚠
// misconception marker — baked into the cached /api/graph payload, so with write_page-only
// invalidation a freshly recorded or freshly resolved misconception kept a stale marker for up to
// a TTL plus a client poll (~90s measured live). This drives the REAL loreweaver through the same
// wrapper the harness uses and asserts the payload is fresh with no TTL wait on either side of
// the lifecycle.
describe('record_evidence graph-cache invalidation (T43)', () => {
  it('a recorded then resolved misconception is fresh in /api/graph with no TTL wait', async () => {
    const { buildRestRoutes } = await import('../src/server/restRoutes.js');
    const { invalidateGraphCache } = await import('../src/server/graphCache.js');
    const app = buildRestRoutes(lw, { student: 'misckid' } as any);
    invalidateGraphCache(); // the earlier /api/graph test primed the cache for a different student
    const clean = await (await app.request('/api/graph')).json();
    expect(clean.nodes[0].mastery).toBeNull(); // cache now warm (TTL 60s) with no misconception
    await lw.call('record_evidence', {
      student: 'misckid', slug: 'derivatives', kind: 'misconception',
      note: 'thinks dx is a multiplicative factor', misconception: 'thinks dx is a multiplicative factor',
    });
    const recorded = await (await app.request('/api/graph')).json();
    expect(recorded.nodes[0].mastery.misconceptions).toContain('thinks dx is a multiplicative factor');
    await lw.call('record_evidence', {
      student: 'misckid', slug: 'derivatives', kind: 'explained-correctly',
      note: 'explained dx as limit notation', resolves: 'dx is a multiplicative factor',
    });
    const resolved = await (await app.request('/api/graph')).json();
    expect(resolved.nodes[0].mastery.misconceptions).not.toContain('thinks dx is a multiplicative factor');
    invalidateGraphCache(); // leave nothing warm for tests that run after this file
  });
});
