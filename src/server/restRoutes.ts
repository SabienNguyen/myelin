import { Hono } from 'hono';
import type { AnkiClient } from './anki/client.js';
import { backlogDays } from './anki/inbound.js';
import { isGapUp } from './gapProxy.js';
import type { Loreweaver } from './mcp.js';
import type { HarnessConfig } from './config.js';
import { getGraphCached, type GraphPayload } from './graphCache.js';

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
  return { nodes, goal: null, summary: student };
}

export function buildRestRoutes(
  lw: Loreweaver, cfg: HarnessConfig, status: Record<string, string | boolean> = {}, anki?: AnkiClient,
) {
  const app = new Hono();

  // Cached (TTL + stale-while-revalidate) — recomputing from every vault page is ~3s live;
  // see src/server/graphCache.ts for the caching contract and mcp.ts for invalidation.
  app.get('/api/graph', async (c) => c.json(await getGraphCached(() => fetchGraph(lw, cfg))));

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
