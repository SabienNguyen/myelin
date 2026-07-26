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
// B2c: mined artifacts (packages/miner output, e.g. the harness vault's own repo-mining pass)
// served IN ADDITION to `rungs` above — see the-gap repo's apps/web/src/server/ladder.ts
// (LadderPayload.mined). Optional (not every /api/ladder response predates this field, and
// callers that only care about the built-in ladder never need to touch it) rather than required,
// so existing code/tests constructing a GapLadderPayload literal don't need updating.
export interface GapMinedArtifactMeta {
  title: string;
  family: string; // e.g. "mined:<repo>"
  source: { repo: string; commit: string; path: string };
}
export interface GapMinedEntry {
  rung: GapRung;
  meta: GapMinedArtifactMeta;
}
export interface GapLadderPayload {
  ladder: { pattern: string; targetArtifactId: string; siblingArtifactId: string; rungs: string[] };
  rungs: GapRung[];
  mined?: GapMinedEntry[];
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
  // No external sidecar -> the built-in sandbox's ladder, through the same stripped payload
  // builder its own HTTP route serializes. Lazy import so gapProxy (which the client help route
  // and ingestRepo also pull in) does not eagerly load the exercise content it usually won't need.
  if (!cfg.gap) {
    const { builtinLadderPayload } = await import('./gap/service.js');
    return builtinLadderPayload();
  }
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
 * a code exercise silently failing to load looks like a harness bug, not "sidecar's off".
 *
 * When cfg.gap is absent this returns the BUILT-IN sandbox's routes instead (gap/service.ts) —
 * the sandbox stopped being an optional extra when it started shipping inside the harness. A
 * configured gap.url still wins, because the external sidecar is the fuller thing (mined
 * artifacts, more patterns). */
export function buildGapRoutes(cfg: HarnessConfig, builtin: () => Hono) {
  if (!cfg.gap) return builtin();
  const app = new Hono();

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

/** One 2s-timeout ping of the sidecar's GET /api/ladder — NOT cached (see isGapUp below for the
 * cached wrapper the `gap` status badge uses). Exported for ingestRepo.ts's post-restart poll
 * (B2c step 5), which needs a FRESH reading on every ~2s tick — isGapUp's 30s cache would happily
 * keep reporting "down" for up to 30s after the restarted sidecar is actually back up, which would
 * make a 30s poll loop built on it nearly useless. Returns false (never throws) when cfg.gap is
 * absent or the sidecar is unreachable, same contract as isGapUp. */
export async function pingGapOnce(cfg: HarnessConfig): Promise<boolean> {
  if (!cfg.gap) return true; // the built-in sandbox is in-process — it is up iff we are
  try {
    const res = await fetch(`${cfg.gap.url.replace(/\/$/, '')}/api/ladder`, {
      signal: AbortSignal.timeout(STATUS_PING_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Powers the `gap` badge on GET /api/status: pingGapOnce, cached 30s so the status endpoint
 * stays cheap under repeated polling. Returns false (not a thrown error) when cfg.gap is absent
 * or the sidecar is unreachable — status checks never throw. */
export async function isGapUp(cfg: HarnessConfig): Promise<boolean> {
  if (!cfg.gap) return true; // built-in, in-process
  const now = Date.now();
  const cached = statusCache.get(cfg);
  if (cached && now - cached.at < STATUS_CACHE_MS) return cached.up;

  const up = await pingGapOnce(cfg);
  statusCache.set(cfg, { at: now, up });
  return up;
}
