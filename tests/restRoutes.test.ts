import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildRestRoutes } from '../src/server/restRoutes.js';
import { invalidateGraphCache } from '../src/server/graphCache.js';
import type { HarnessConfig } from '../src/server/config.js';

const TTL_MS = 60_000;

/** Flush pending microtasks (native Promise resolution — NOT gated by fake timers, which only
 * fake macrotasks like setTimeout/Date) so an un-awaited background refresh gets a chance to
 * finish before we assert on it. */
async function tick(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// compileNext/route tests elsewhere (tests/ingestRepo.test.ts, tests/ingestRoutes.test.ts) use the
// same shape of plain-object stub for the Loreweaver client — a real MCP round-trip for
// GET /api/graph is already covered by tests/mcp.test.ts.
function fakeLw(opts: { slugs?: string[]; fail?: () => boolean } = {}) {
  const { slugs = ['a'], fail = () => false } = opts;
  let listSlugsCalls = 0;
  const lw = {
    listSlugs: async () => {
      listSlugsCalls++;
      if (fail()) throw new Error('lw down');
      return slugs;
    },
    call: async (name: string, args: any) => {
      if (fail()) throw new Error('lw down');
      // Tag the top-level (no-slug) get_student_state response with the current fetch number so
      // tests can tell a fresh fetch's payload apart from a stale one without inspecting mocks.
      if (name === 'get_student_state' && args.slug === undefined) {
        return { detail: null, fetchNum: listSlugsCalls };
      }
      if (name === 'get_student_state') return { detail: null };
      if (name === 'read_page') {
        return { page: { meta: { title: args.slug, difficulty: 1, status: 'stub', prereqs: [], deepens: [] } } };
      }
      throw new Error(`fakeLw: unexpected call ${name}`);
    },
  } as any;
  return { lw, listSlugsCalls: () => listSlugsCalls };
}

const cfg = { student: 'kid' } as HarnessConfig;

beforeEach(() => { invalidateGraphCache(); });
afterEach(() => { vi.useRealTimers(); });

describe('GET /api/graph caching', () => {
  it('cold call hits lw once', async () => {
    const { lw, listSlugsCalls } = fakeLw();
    const app = buildRestRoutes(lw, cfg);
    const res = await app.request('/api/graph');
    expect(res.status).toBe(200);
    expect(listSlugsCalls()).toBe(1);
  });

  it('second call within TTL serves cache without a second lw call', async () => {
    const { lw, listSlugsCalls } = fakeLw();
    const app = buildRestRoutes(lw, cfg);
    const first = await (await app.request('/api/graph')).json();
    const second = await (await app.request('/api/graph')).json();
    expect(second).toEqual(first);
    expect(listSlugsCalls()).toBe(1);
  });

  it('a failed cold-cache call surfaces the error, as today', async () => {
    const { lw, listSlugsCalls } = fakeLw({ fail: () => true });
    const app = buildRestRoutes(lw, cfg);
    const res = await app.request('/api/graph');
    expect(res.status).toBe(500); // Hono's default: an uncaught handler error becomes a 500
    expect(listSlugsCalls()).toBe(1);
  });

  it('after TTL expiry, the stale payload returns instantly while exactly ONE refresh fires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { lw, listSlugsCalls } = fakeLw();
    const app = buildRestRoutes(lw, cfg);

    const cold = await (await app.request('/api/graph')).json();
    expect(cold.summary.fetchNum).toBe(1);
    expect(listSlugsCalls()).toBe(1);

    vi.setSystemTime(TTL_MS + 1); // now stale

    // Two concurrent requests while stale must dedup to exactly one background refresh.
    const [r1, r2] = await Promise.all([app.request('/api/graph'), app.request('/api/graph')]);
    const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
    expect(b1).toEqual(cold); // stale payload served immediately, unchanged
    expect(b2).toEqual(cold);

    await tick(); // let the single background refresh resolve
    expect(listSlugsCalls()).toBe(2); // exactly one refresh fired, not one per concurrent request

    // Next request after the refresh landed sees the fresh payload, cache hit (no third lw hit).
    const after = await (await app.request('/api/graph')).json();
    expect(after.summary.fetchNum).toBe(2);
    expect(listSlugsCalls()).toBe(2);
  });

  it('invalidateGraphCache forces the next call to refetch', async () => {
    const { lw, listSlugsCalls } = fakeLw();
    const app = buildRestRoutes(lw, cfg);
    await app.request('/api/graph');
    expect(listSlugsCalls()).toBe(1);

    invalidateGraphCache();

    const res = await (await app.request('/api/graph')).json();
    expect(res.summary.fetchNum).toBe(2);
    expect(listSlugsCalls()).toBe(2);
  });

  it('a failed background refresh logs once and keeps serving the stale cache', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let shouldFail = false;
    const { lw, listSlugsCalls } = fakeLw({ fail: () => shouldFail });
    const app = buildRestRoutes(lw, cfg);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const cold = await (await app.request('/api/graph')).json();

    vi.setSystemTime(TTL_MS + 1);
    shouldFail = true;
    const stale = await (await app.request('/api/graph')).json();
    expect(stale).toEqual(cold); // still the old payload, served without waiting

    await tick();
    expect(listSlugsCalls()).toBe(2); // the failed refresh attempt did happen
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/\[graphCache\]/);

    // Cache isn't corrupted by the failure — still serves the last-good payload right after.
    // (lw is still failing here, so this call also kicks off — and loses — its own retry; that's
    // covered below rather than asserted on here, to keep this assertion about the failure itself.)
    shouldFail = false; // let the NEXT refresh attempt succeed before making that next call

    const recovering = await (await app.request('/api/graph')).json();
    expect(recovering).toEqual(cold); // still stale-serve — the refresh hasn't landed yet
    await tick();
    expect(listSlugsCalls()).toBe(3); // one more attempt, this time it succeeds
    expect(errorSpy).toHaveBeenCalledTimes(1); // no new error logged for the successful retry

    const recovered = await (await app.request('/api/graph')).json();
    expect(recovered.summary.fetchNum).toBe(3); // fresh cache now serves the recovered payload
    expect(listSlugsCalls()).toBe(3); // served from cache, no extra lw hit

    errorSpy.mockRestore();
  });
});
