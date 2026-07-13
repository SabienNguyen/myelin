import { Hono } from 'hono';
import type { AnkiClient } from './anki/client.js';
import { backlogDays } from './anki/inbound.js';
import type { Loreweaver } from './mcp.js';
import type { HarnessConfig } from './config.js';

export function buildRestRoutes(
  lw: Loreweaver, cfg: HarnessConfig, status: Record<string, string> = {}, anki?: AnkiClient,
) {
  const app = new Hono();

  app.get('/api/graph', async (c) => {
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
    return c.json({ nodes, goal: null, summary: student });
  });

  app.get('/api/page/:slug', async (c) =>
    c.json(await lw.call('read_page', { slug: c.req.param('slug') })));
  app.get('/api/student', async (c) =>
    c.json(await lw.call('get_student_state', { student: cfg.student })));
  app.get('/api/status', async (c) => {
    if (!anki) return c.json(status);
    const up = await anki.isUp();
    const backlog = !up && backlogDays(cfg.vault) > cfg.schedule.ankiBacklogNudgeDays;
    return c.json({ ...status, anki: up ? 'up' : backlog ? 'backlog' : 'down' });
  });
  return app;
}
