// In-memory cache for the GET /api/graph payload.
//
// The handler recomputes the graph from every vault page on each call (~3s for the current
// ~172-page vault — see restRoutes.ts), so it's cached with a TTL plus stale-while-revalidate:
// once the entry goes stale, the last-known-good payload is returned IMMEDIATELY and exactly one
// background refresh is kicked off to update it for the NEXT caller. Only the very first
// (cold-cache) request pays the real ~3s cost synchronously, same as before this cache existed.
//
// Invalidation: the harness's own writes shouldn't wait out the TTL to show up. `invalidateGraphCache()`
// is called from the Loreweaver client wrapper (src/server/mcp.ts) whenever a `write_page` tool
// call completes successfully — see the comment there for why that's the chosen seam. Edits made
// outside the harness (e.g. a user editing the vault directly in Obsidian) aren't covered by
// invalidation and are simply picked up within one TTL window.

const TTL_MS = 60_000;

export interface GraphPayload {
  nodes: unknown[];
  /** The active goal's slug, or null when none is set. Was typed as the literal `null` — a
   *  placeholder that was never populated — until goalStore gave the field something to carry. */
  goal: string | null;
  summary: unknown;
}

interface CacheEntry {
  value: GraphPayload;
  fetchedAt: number;
}

let cached: CacheEntry | null = null;
let refreshing: Promise<void> | null = null;

/** Drops the cached payload so the next getGraphCached() call awaits a fresh fetch. */
export function invalidateGraphCache(): void {
  cached = null;
}

/**
 * Returns the graph payload, using `fetchGraph` to (re)compute it as needed:
 * - cold cache: awaits fetchGraph() directly (errors propagate, as before this cache existed).
 * - fresh cache (age < TTL_MS): returns the cached value, no call to fetchGraph().
 * - stale cache: returns the cached value immediately and, unless a refresh is already in
 *   flight, starts exactly one background fetchGraph() call to update the cache for next time.
 *   A failed background refresh logs once and leaves the stale value in place.
 */
export async function getGraphCached(fetchGraph: () => Promise<GraphPayload>): Promise<GraphPayload> {
  if (!cached) {
    const value = await fetchGraph();
    cached = { value, fetchedAt: Date.now() };
    return value;
  }

  const isStale = Date.now() - cached.fetchedAt >= TTL_MS;
  if (isStale && !refreshing) {
    refreshing = fetchGraph()
      .then((value) => { cached = { value, fetchedAt: Date.now() }; })
      .catch((e) => { console.error('[graphCache] background refresh failed, serving stale graph payload:', e); })
      .finally(() => { refreshing = null; });
  }
  return cached.value;
}
