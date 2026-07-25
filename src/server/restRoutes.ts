import { Hono } from 'hono';
import type { AnkiClient } from './anki/client.js';
import { backlogDays } from './anki/inbound.js';
import { isGapUp } from './gapProxy.js';
import type { Loreweaver } from './mcp.js';
import type { HarnessConfig } from './config.js';
import { getGraphCached, type GraphPayload } from './graphCache.js';
import { readGoal, writeGoal, pathProgress } from './goalStore.js';

async function fetchGraph(lw: Loreweaver, cfg: HarnessConfig): Promise<GraphPayload> {
  const [slugs, student] = await Promise.all([
    lw.listSlugs(),
    lw.call('get_student_state', { student: cfg.student }),
  ]);
  const nodes = await Promise.all(slugs.map(async (slug) => {
    const { page } = await lw.call('read_page', { slug });
    const detail = await lw.call('get_student_state', { student: cfg.student, slug });
    return {
      slug, title: page.meta.title, difficulty: page.meta.difficulty, status: page.meta.status,
      prereqs: page.meta.prereqs, deepens: page.meta.deepens,
      mastery: detail.detail ?? null,
    };
  }));
  // `goal` has been hardcoded null since this payload was written. It now carries the active
  // goal's slug so the Graph can centre on what the learner is actually working toward.
  return { nodes, goal: readGoal(cfg.vault)?.slug ?? null, summary: student };
}

export function buildRestRoutes(
  lw: Loreweaver, cfg: HarnessConfig, status: Record<string, string | boolean> = {}, anki?: AnkiClient,
) {
  const app = new Hono();

  // Cached (TTL + stale-while-revalidate) — recomputing from every vault page is ~3s live;
  // see src/server/graphCache.ts for the caching contract and mcp.ts for invalidation.
  app.get('/api/graph', async (c) => c.json(await getGraphCached(() => fetchGraph(lw, cfg))));

  // Curated paths — Loreweaver's syllabus primitive. It has existed since the first version
  // (create_path / list_paths / read_path) with NO learner-facing surface at all: the tutor could
  // read a path, the learner could never see one, so a subject had no visible spine and no sense of
  // "how far through am I". These two routes plus the Library's Paths section are that surface.
  app.get('/api/paths', async (c) => {
    const [paths, state] = await Promise.all([
      lw.call('list_paths', {}),
      lw.call('get_student_state', { student: cfg.student }),
    ]);
    const goal = readGoal(cfg.vault);
    return c.json({
      goal,
      paths: (paths ?? []).map((p: any) => pathProgress(p, state)),
    });
  });

  app.get('/api/path/:slug', async (c) => {
    const doc = await lw.call('read_path', { slug: c.req.param('slug') });
    const state = await lw.call('get_student_state', { student: cfg.student });
    // Per-page mastery so the detail view can mark each step, not just the total.
    const pages = (doc.pages ?? []).map((slug: string) => ({
      slug, effective: state[slug]?.effective ?? 'unseen',
    }));
    return c.json({ ...doc, pages, progress: pathProgress(doc, state) });
  });

  app.get('/api/goal', (c) => c.json(readGoal(cfg.vault)));
  app.put('/api/goal', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    // Explicit null clears the goal; anything malformed is a 400 rather than a silent no-op, since a
    // goal that silently failed to save is worse than one that visibly did not.
    if (body === null || body?.slug === null) return c.json(writeGoal(cfg.vault, null));
    if (body?.kind !== 'path' && body?.kind !== 'page') return c.json({ error: 'kind must be path or page' }, 400);
    try {
      return c.json(writeGoal(cfg.vault, { kind: body.kind, slug: String(body.slug ?? '') }));
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 400);
    }
  });

  app.get('/api/page/:slug', async (c) =>
    c.json(await lw.call('read_page', { slug: c.req.param('slug') })));
  app.get('/api/student', async (c) =>
    c.json(await lw.call('get_student_state', { student: cfg.student })));
  app.get('/api/status', async (c) => {
    const extra: Record<string, string> = {};
    if (anki) {
      const up = await anki.isUp();
      const backlog = !up && backlogDays(cfg.vault) > cfg.schedule.ankiBacklogNudgeDays;
      extra.anki = up ? 'up' : backlog ? 'backlog' : 'down';
    }
    if (cfg.gap) extra.gap = (await isGapUp(cfg)) ? 'up' : 'down';
    if (!anki && !cfg.gap) return c.json(status);
    return c.json({ ...status, ...extra });
  });
  return app;
}
