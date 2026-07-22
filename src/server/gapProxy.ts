import { Hono } from 'hono';
import type { HarnessConfig } from './config.js';

const PROXY_TIMEOUT_MS = 30_000;
const STATUS_PING_TIMEOUT_MS = 2_000;
const STATUS_CACHE_MS = 30_000;

// Wire shapes for the-gap sidecar's GET /api/ladder response (mirrors the subset
// src/client/components/blocks/gap/types.ts ports — duplicated here rather than imported
// because server code must not depend on client code). `reference_answer` is named so a stray
// leak into a server-side consumer would be visible in a type-level diff — see helpPrompt.ts's
// top comment for why the help route's prompt builder uses a DIFFERENT type that omits it
// entirely rather than picking fields off this one.
export interface GapRung {
  id: string;
  template: 'worked_example' | 'inline_completion' | 'full_body';
  artifactId: string;
  visible_pre: string;
  visible_post: string;
  reference_answer: string;
  prose?: { context_line?: string; hint?: string; success_line?: string };
}
export interface GapLadderPayload {
  ladder: { pattern: string; targetArtifactId: string; siblingArtifactId: string; rungs: string[] };
  rungs: GapRung[];
}

/** Fetches the-gap sidecar's GET /api/ladder — the ONE endpoint the sidecar ever returns rung
 * data from, and the one it already strips reference_answer through server-side for every
 * non-worked_example rung before the response is ever serialized (see server.ts's
 * buildLadderPayload in the-gap repo). Shared by the GET /api/gap/ladder passthrough route below
 * and gapHelp.ts's /api/gap/help route, so both ever reach rung data through this exact one
 * fetch — the mechanical half of the answer-integrity invariant: there is no second, unstripped
 * endpoint for either caller to reach instead. Throws on a down/non-OK sidecar; callers translate
 * that into their own error shape. */
export async function fetchLadderPayload(cfg: HarnessConfig): Promise<GapLadderPayload> {
  if (!cfg.gap) throw new Error('gap sidecar not configured');
  const base = cfg.gap.url.replace(/\/$/, '');
  const res = await fetch(`${base}/api/ladder`, { signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
  const data = await res.json();
  if (!res.ok) throw new Error(`gap sidecar /api/ladder returned ${res.status}`);
  return data as GapLadderPayload;
}

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

  app.get('/api/gap/ladder', async (c) => {
    try {
      return c.json(await fetchLadderPayload(cfg));
    } catch (e: any) {
      return c.json({ error: `gap sidecar unavailable: ${e?.message ?? e}` }, 502);
    }
  });
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
