import { Hono } from 'hono';
import type { HarnessConfig } from './config.js';

const PROXY_TIMEOUT_MS = 30_000;
const STATUS_PING_TIMEOUT_MS = 2_000;
const STATUS_CACHE_MS = 30_000;

/** Proxies /api/gap/* to the-gap sidecar's own /api/* (GET /api/ladder, POST /api/run — the
 * Pinned Contract in docs/superpowers/plans/2026-07-20-gap-integration.md). Passthrough is
 * verbatim: the sidecar already strips reference_answer for non-worked_example rungs before
 * this proxy ever sees the payload, so there is nothing to strip or re-add here — this proxy
 * must not touch response bodies beyond re-serializing them as JSON. Degrades LOUDLY: a
 * sidecar-down response is a structured 502 { error }, never a swallowed empty result, because
 * a code exercise silently failing to load looks like a harness bug, not "sidecar's off". When
 * cfg.gap is absent the returned app has no routes registered at all — /api/gap/* 404s upstream,
 * same "feature off when config absent" pattern as buildWebTools. */
export function buildGapRoutes(cfg: HarnessConfig) {
  const app = new Hono();
  if (!cfg.gap) return app;

  const base = cfg.gap.url.replace(/\/$/, '');

  app.get('/api/gap/ladder', (c) => proxy(c, `${base}/api/ladder`, 'GET'));
  app.post('/api/gap/run', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return proxy(c, `${base}/api/run`, 'POST', body);
  });

  return app;
}

async function proxy(c: any, url: string, method: 'GET' | 'POST', body?: unknown) {
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    const data = await res.json();
    return c.json(data, res.status);
  } catch (e: any) {
    return c.json({ error: `gap sidecar unavailable: ${e?.message ?? e}` }, 502);
  }
}

// Keyed by the cfg object itself (one per boot in production, one per test fixture in tests) so
// the cache never leaks across unrelated config instances — no manual reset hook needed.
const statusCache = new WeakMap<object, { at: number; up: boolean }>();

/** Powers the `gap` badge on GET /api/status: a 2s-timeout ping of the sidecar's GET /api/ladder,
 * cached 30s so the status endpoint stays cheap under repeated polling. Returns false (not a
 * thrown error) when cfg.gap is absent or the sidecar is unreachable — status checks never
 * throw. */
export async function isGapUp(cfg: HarnessConfig): Promise<boolean> {
  if (!cfg.gap) return false;
  const now = Date.now();
  const cached = statusCache.get(cfg);
  if (cached && now - cached.at < STATUS_CACHE_MS) return cached.up;

  let up: boolean;
  try {
    const res = await fetch(`${cfg.gap.url.replace(/\/$/, '')}/api/ladder`, {
      signal: AbortSignal.timeout(STATUS_PING_TIMEOUT_MS),
    });
    up = res.ok;
  } catch {
    up = false;
  }
  statusCache.set(cfg, { at: now, up });
  return up;
}
