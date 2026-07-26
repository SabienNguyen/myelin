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

/**
 * Resolve every slug this page points at (or is pointed at by) to a title plus the learner's own
 * effective mastery on it.
 *
 * `read_page` returns edges as bare slugs, which is why the Page panel could only ever have shown
 * `[[chain-rule]]`-style identifiers — accurate, and useless for deciding whether to click. What the
 * learner needs on a prerequisite is "do I already know this?", and the vault knows.
 *
 * Deliberately NOT sourced from the graph cache: that cache is populated by fetchGraph, which reads
 * EVERY page in the vault (~3s cold), and making the first page view pay that is a bad trade for a
 * handful of titles. This resolves only the actual neighbours — bounded by the page's own edge
 * count, issued in parallel, plus one bulk student-state call for all of them.
 *
 * A neighbour that fails to resolve gets `title: null` rather than being dropped. That case is real
 * (Loreweaver's `missingTargets` names it: a page may declare a prereq nobody has written yet) and
 * showing it as a dead link is more honest than silently rendering a shorter list.
 */
async function resolveNeighbors(lw: Loreweaver, cfg: HarnessConfig, page: any) {
  const slugs = new Set<string>([
    ...(page?.edges?.out ?? []).map((e: any) => e.dst),
    ...(page?.edges?.in ?? []).map((e: any) => e.src),
  ]);
  slugs.delete(page?.page?.slug);
  if (slugs.size === 0) return {};

  const [state, resolved] = await Promise.all([
    lw.call('get_student_state', { student: cfg.student }).catch(() => ({})),
    Promise.all([...slugs].map(async (slug) => {
      const title = await lw.call('read_page', { slug })
        .then((p: any) => p.page.meta.title as string)
        .catch(() => null);
      return [slug, title] as const;
    })),
  ]);

  const out: Record<string, { title: string | null; mastery: string | null }> = {};
  for (const [slug, title] of resolved) {
    // `effective` is the decay-adjusted level — the same number the graph and the tutor act on, so
    // a prereq that has rotted back to `exposed` reads as exposed here too rather than as mastered.
    out[slug] = { title, mastery: (state as any)?.[slug]?.effective ?? null };
  }
  return out;
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

  /**
   * The learner's own standing on this page, plus HOW it was earned.
   *
   * The app has always shown a mastery LEVEL and never how the level was reached, so the one
   * question a level provokes — "why is this only practising?" — had no answer anywhere in the UI.
   * The data was always there: every evidence entry records its kind, and since grading.ts's
   * capApplied, 'applied-correctly' means a machine confirmed it while 'explained-correctly' means
   * a model judged it. Counting them is the whole feature.
   */
  async function readStanding(slug: string) {
    const state = await lw.call('get_student_state', { student: cfg.student, slug }).catch(() => null);
    const d = (state as any)?.detail;
    if (!d) return null;
    const evidence: { kind: string }[] = d.evidence ?? [];
    const count = (kind: string) => evidence.filter((e) => e.kind === kind).length;
    return {
      level: d.level as string,
      // `effective` is decay-adjusted — the number every query and the graph act on. Showing the
      // stored level instead would tell the learner they are mastered while the tutor reteaches it.
      effective: d.effective as string,
      lastReinforced: d.last_reinforced as string,
      applied: count('applied-correctly'),
      explained: count('explained-correctly'),
      rubric: count('rubric-passed'),
      // Mirrors loreweaver's restsOnRubric walk, so the panel's decay countdown uses the SAME
      // window the memory layer will actually decay on. Without this the countdown promised 21
      // days to a page that rots in 14.
      restsOnRubric: (() => {
        for (let i = evidence.length - 1; i >= 0; i--) {
          const k = evidence[i].kind;
          if (k === 'applied-correctly' || k === 'explained-correctly') return false;
          if (k === 'rubric-passed') return true;
        }
        return false;
      })(),
      struggled: count('struggled'),
      misconceptions: (d.misconceptions ?? []) as string[],
    };
  }

  app.get('/api/page/:slug', async (c) => {
    const slug = c.req.param('slug');
    let page: any;
    try {
      page = await lw.call('read_page', { slug });
    } catch (e: any) {
      // read_page answers `page not found: <slug>` for a slug with no file, and lw.call turns any
      // tool error into a throw — so an ordinary dead wiki-link came back as a 500 and the panel
      // told the learner "the harness hit an error". A page that was never written is not a
      // failure of the harness; it is the most common thing a graph with dangling edges produces.
      const message = String(e?.message ?? e);
      if (/page not found/i.test(message)) return c.json({ error: `no page for “${slug}” yet` }, 404);
      throw e;
    }
    const [neighbors, standing] = await Promise.all([
      resolveNeighbors(lw, cfg, page),
      readStanding(slug),
    ]);
    return c.json({ ...page, neighbors, standing });
  });
  app.get('/api/student', async (c) =>
    c.json(await lw.call('get_student_state', { student: cfg.student })));
  app.get('/api/status', async (c) => {
    // Read the tutor model from cfg HERE, not from the snapshot passed in at boot. Signing in with a
    // Claude subscription rewrites it while the app is running (signin.ts's applyRoute), and a
    // captured string meant the status badge kept naming the model the app had stopped using.
    const extra: Record<string, string> = { tutor: cfg.models.tutor.model };
    if (anki) {
      const up = await anki.isUp();
      const backlog = !up && backlogDays(cfg.vault) > cfg.schedule.ankiBacklogNudgeDays;
      extra.anki = up ? 'up' : backlog ? 'backlog' : 'down';
    }
    // Unconditional: with no external sidecar configured, isGapUp reports the built-in
    // sandbox — in-process, so up iff this server is.
    extra.gap = (await isGapUp(cfg)) ? 'up' : 'down';
    return c.json({ ...status, ...extra });
  });
  return app;
}
