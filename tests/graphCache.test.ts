import { describe, it, expect, beforeEach } from 'vitest';
import { getGraphCached, invalidateGraphCache, type GraphPayload } from '../src/server/graphCache.js';

const payload = (tag: string): GraphPayload => ({ nodes: [tag], goal: null, summary: tag });

describe('graphCache', () => {
  beforeEach(() => invalidateGraphCache()); // each test starts from a cold cache

  it('computes once, then serves the cached value without re-fetching', async () => {
    let calls = 0;
    const fetch = async () => { calls += 1; return payload('a'); };
    expect((await getGraphCached(fetch)).summary).toBe('a');
    expect((await getGraphCached(fetch)).summary).toBe('a');
    expect(calls).toBe(1); // second call is a cache hit
  });

  it('invalidation forces the next call to re-fetch', async () => {
    let calls = 0;
    const fetch = async () => { calls += 1; return payload(`v${calls}`); };
    await getGraphCached(fetch);
    invalidateGraphCache();
    expect((await getGraphCached(fetch)).summary).toBe('v2');
    expect(calls).toBe(2);
  });

  it('an invalidation racing an in-flight fetch does not get clobbered by that fetch', async () => {
    // The write-during-refresh race: a fetch reading the pre-write vault must not install its stale
    // payload after a write_page invalidated the cache, or the write hides for a whole TTL despite
    // the invalidation having fired.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const stale = payload('pre-write');
    const inflight = getGraphCached(async () => { await gate; return stale; });
    invalidateGraphCache(); // a write_page completes while the fetch is mid-flight
    release();
    expect(await inflight).toBe(stale); // this caller still gets what it fetched

    // …but the cache was NOT poisoned with the stale value: the next caller re-fetches and sees the
    // write. Without the generation guard this returned 'pre-write' — the write hidden for a TTL.
    const fresh = await getGraphCached(async () => payload('post-write'));
    expect(fresh.summary).toBe('post-write');
  });
});
