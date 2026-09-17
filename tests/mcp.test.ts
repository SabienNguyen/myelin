import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engram, isTransportError, EngramToolError, searchHits, searchNote } from '../src/server/mcp.js';
import type { HarnessConfig } from '../src/server/config.js';
import { LW_REPO } from './lwRepo.js';

let lw: Engram;
let vault: string;

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), 'lwh-vault-'));
  mkdirSync(join(vault, 'pages'), { recursive: true });
  writeFileSync(join(vault, 'pages', 'derivatives.md'),
    '---\ntitle: Derivatives\ndifficulty: 1\nstatus: solid\n---\nrates of change');
  const cfg = {
    vault, student: 'testkid',
    engram: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
  } as HarnessConfig;
  lw = await Engram.connect(cfg);
}, 30_000);

afterAll(async () => { await lw.close(); });

describe('Engram client', () => {
  it('lists slugs by glob without parsing', async () => {
    expect(await lw.listSlugs()).toEqual(['derivatives']);
  });
  it('calls read_page and parses JSON', async () => {
    const page = await lw.call('read_page', { slug: 'derivatives' });
    expect(page.page.meta.title).toBe('Derivatives');
  });
  it('exposes tools for the agent loop', async () => {
    const tools = await lw.tools();
    expect(tools.map((t) => t.name)).toContain('record_evidence');
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
    expect(tools.map((t) => t.name)).toContain('record_evidence');
    const raw: any = await tools.find((t) => t.name === 'read_page')!.execute!({ slug: 'derivatives' });
    const parsed = JSON.parse(raw.content[0].text);
    expect(parsed.page.meta.title).toBe('Derivatives');
  });

  it("recovers a previously-fetched tool's execute after the transport dies underneath it", async () => {
    const tools = await lw.tools(); // fetched while the client is alive
    await (lw as any).client.close(); // kill the client the fetched tool's closure was bound to
    const raw: any = await tools.find((t) => t.name === 'read_page')!.execute!({ slug: 'derivatives' });
    const parsed = JSON.parse(raw.content[0].text);
    expect(parsed.page.meta.title).toBe('Derivatives');
  });

  // H1 (audit 2026-08-30): TRANSPORT_ERROR used to match the bare word "closed" anywhere in an
  // error message, so an ordinary vault miss like `engram read_page: page not found:
  // closed-loop-control` — "closed" landing inside the SLUG, not the transport — read as a dead
  // child. withRespawn respawned engram and clobbered `this.client` over the still-live one,
  // leaking a process per miss. These pin the fix on both sides: a tool-result error (now
  // EngramToolError) never respawns; a real transport rejection still does, and closes the old
  // client before handing out the new one.
  it('does not respawn on an ordinary tool-result error, even when its text contains "closed"', async () => {
    const realSpawn = (Engram as any).spawn.bind(Engram);
    let spawns = 0;
    (Engram as any).spawn = (cfg: any) => { spawns += 1; return realSpawn(cfg); };
    try {
      await expect(lw.call('read_page', { slug: 'closed-loop-control' }))
        .rejects.toThrow('engram read_page: page not found: closed-loop-control');
      expect(spawns).toBe(0); // no respawn — the live engram process is untouched
    } finally {
      (Engram as any).spawn = realSpawn;
    }
  });

  it('rejects tool-result errors as EngramToolError, which isTransportError always refuses', () => {
    // Even given a message that reads exactly like a transport failure, the class tag wins.
    expect(isTransportError(new EngramToolError('mcp transport closed: not really'))).toBe(false);
  });

  it('respawns and closes the old client on a real transport-shaped rejection', async () => {
    const deadClient = (lw as any).client;
    const order: string[] = [];
    const originalClose = deadClient.close.bind(deadClient);
    deadClient.close = async () => { order.push('close'); return originalClose(); };
    deadClient.callTool = async () => { throw new Error('mcp transport closed: write EPIPE'); };

    const realSpawn = (Engram as any).spawn.bind(Engram);
    let spawns = 0;
    (Engram as any).spawn = (cfg: any) => {
      order.push('spawn');
      spawns += 1;
      return realSpawn(cfg);
    };
    try {
      const page = await lw.call('read_page', { slug: 'derivatives' });
      expect(page.page.meta.title).toBe('Derivatives');
      expect(spawns).toBe(1);
      expect(order).toEqual(['close', 'spawn']); // old client torn down before the fresh one is assigned
    } finally {
      (Engram as any).spawn = realSpawn;
    }
  });

  it('respawns the child ONCE when the transport dies under concurrent calls, not once per call', async () => {
    // The compile path runs several tool calls at once (concurrency workers). If the child dies,
    // they all hit the transport error together — each used to spawn its own replacement and orphan
    // all but the last. Count spawns across three concurrent recoveries: it must be exactly one.
    await (lw as any).client.close();
    const realSpawn = (Engram as any).spawn.bind(Engram);
    let spawns = 0;
    (Engram as any).spawn = (cfg: any) => { spawns += 1; return realSpawn(cfg); };
    try {
      const pages = await Promise.all([
        lw.call('read_page', { slug: 'derivatives' }),
        lw.call('read_page', { slug: 'derivatives' }),
        lw.call('read_page', { slug: 'derivatives' }),
      ]);
      expect(pages.every((p) => p.page.meta.title === 'Derivatives')).toBe(true);
      expect(spawns).toBe(1); // one shared respawn — three before this fix
    } finally {
      (Engram as any).spawn = realSpawn;
    }
  });
}, 60_000);

// T13: engram's search result changed from a bare array to `{results, note?}`. Both consumers
// (session.ts's vaultGap, rails.ts's askedForItem) go through searchHits()/searchNote(), so this
// pins the parsing itself rather than re-deriving it inside each consumer's own test.
describe('searchHits / searchNote', () => {
  const hit = { slug: 'derivatives', title: 'Derivatives', score: 0.9 };

  it('unwraps the older bare-array shape', () => {
    expect(searchHits([hit])).toEqual([hit]);
    expect(searchNote([hit])).toBeUndefined();
  });

  it('unwraps the newer {results, note} shape', () => {
    expect(searchHits({ results: [hit], note: 'embeddings unavailable' })).toEqual([hit]);
    expect(searchNote({ results: [hit], note: 'embeddings unavailable' })).toBe('embeddings unavailable');
  });

  it('omits note when the newer shape carries none', () => {
    expect(searchHits({ results: [hit] })).toEqual([hit]);
    expect(searchNote({ results: [hit] })).toBeUndefined();
  });

  it('returns [] and no note for anything unrecognized', () => {
    expect(searchHits(null)).toEqual([]);
    expect(searchHits(undefined)).toEqual([]);
    expect(searchHits({})).toEqual([]);
    expect(searchHits({ results: 'not an array' })).toEqual([]);
    expect(searchNote(null)).toBeUndefined();
    expect(searchNote({})).toBeUndefined();
  });
});

describe('isTransportError', () => {
  it('matches the mcpClient stdio transport\'s own rejections', () => {
    expect(isTransportError(new Error('mcp transport closed: client closed'))).toBe(true);
    expect(isTransportError(new Error('mcp transport closed: server exited (code 1)'))).toBe(true);
    expect(isTransportError(new Error('mcp transport timeout: read_page'))).toBe(true);
  });
  it('matches raw EPIPE and ECONNRESET from a dying child\'s stdio', () => {
    expect(isTransportError(new Error('write EPIPE'))).toBe(true);
    expect(isTransportError(new Error('read ECONNRESET'))).toBe(true);
  });
  it('does not match unrelated errors, even ones that mention "closed"', () => {
    expect(isTransportError(new Error('page not found: nope'))).toBe(false);
    expect(isTransportError(new Error('page not found: closed-loop-control'))).toBe(false);
  });
  it('never matches an EngramToolError, regardless of its message', () => {
    expect(isTransportError(new EngramToolError('engram read_page: page not found: closed-loop-control')))
      .toBe(false);
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
// a TTL plus a client poll (~90s measured live). This drives the REAL engram through the same
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
