import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import type { AnkiClient } from './anki/client.js';
import { backlogDays } from './anki/inbound.js';
import { isGapUp } from './gapProxy.js';
import type { Engram } from './mcp.js';
import type { HarnessConfig } from './config.js';
import { getGraphCached, type GraphPayload } from './graphCache.js';
import { readGoal, writeGoal, pathProgress } from './goalStore.js';
import { appliedRoutesFor, missingLadder } from './appliedRoutes.js';
import { readBank } from './courseBank.js';
import { BUILTIN_PATTERN_SLUGS } from './seedPatternPages.js';
import { readUsage } from './usageLedger.js';

async function fetchGraph(lw: Engram, cfg: HarnessConfig): Promise<GraphPayload> {
  // Two calls for the whole vault, however large. The old shape — read_page plus a per-slug
  // get_student_state for EVERY page — was 1+2N stdio roundtrips: a synthetic 500-page vault
  // measured 10.9s for its first graph build. The whole-map student call already carries every
  // field the graph reads (effective, last_reinforced, misconceptions), and list_pages
  // (engram) returns all page metadata in one snapshot. Same fixture after: well under a
  // second.
  const student = await lw.call('get_student_state', { student: cfg.student });
  let nodes: GraphPayload['nodes'];
  try {
    const { pages } = await lw.call('list_pages', {}) as { pages: any[] };
    if (!Array.isArray(pages)) throw new Error('no pages array');
    nodes = pages.map((p) => ({
      slug: p.slug, title: p.title, difficulty: p.difficulty, status: p.status,
      prereqs: p.prereqs, deepens: p.deepens,
      mastery: (student as Record<string, any>)[p.slug] ?? null,
    }));
  } catch {
    // An older bundled engram without list_pages: the per-page path still works, it is just
    // slow at scale. Version skew is real for packaged apps, so degrade rather than break.
    const slugs = await lw.listSlugs();
    nodes = await Promise.all(slugs.map(async (slug) => {
      const { page } = await lw.call('read_page', { slug });
      return {
        slug, title: page.meta.title, difficulty: page.meta.difficulty, status: page.meta.status,
        prereqs: page.meta.prereqs, deepens: page.meta.deepens,
        mastery: (student as Record<string, any>)[slug] ?? null,
      };
    }));
  }
  // A factory-shipped demo pattern the learner has never touched is infrastructure, not part of
  // their knowledge story — on a cold start it was the ONLY node in the graph, a lone "Consuming
  // SSE token streams" nobody asked for. It joins the graph once they engage (any mastery record)
  // or the page grows past its stub; Practice and the Page tab list it regardless. Applied after
  // both fetch paths so the version-skew fallback gets the same rule. See BUILTIN_PATTERN_SLUGS.
  nodes = nodes.filter((n: any) => !(BUILTIN_PATTERN_SLUGS.has(n.slug) && n.mastery == null && n.status === 'stub'));
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
 * (Engram's `missingTargets` names it: a page may declare a prereq nobody has written yet) and
 * showing it as a dead link is more honest than silently rendering a shorter list.
 */
async function resolveNeighbors(lw: Engram, cfg: HarnessConfig, page: any) {
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

/**
 * Break up same-topic adjacency in an already kind-interleaved plan. The rotation in
 * `/api/session-plan` alternates by KIND (review / new / fix / course), but interleaving's actual
 * mechanism is juxtaposing DISSIMILAR items so the learner has to discriminate which idea applies —
 * and when one kind fills several consecutive slots (e.g. five reviews, nothing new due), two rows
 * on the same topic can still sit side by side. That's blocked practice the kind-rotation didn't
 * catch.
 *
 * Greedy and STABLE: position 0 is left where it is (the review queue promises most-urgent-first),
 * and any later row that repeats its predecessor's topic is swapped with the nearest following row
 * of a different topic. A pure no-op when topics are absent or all equal — so an untagged vault, a
 * single-topic sitting, and every test that sets no tags keep their exact rotation order.
 */
export function interleaveByTopic<T extends { _topic?: string }>(items: T[]): T[] {
  const out = items.slice();
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]._topic;
    if (prev == null || out[i]._topic !== prev) continue;
    const j = out.findIndex((it, k) => k > i && it._topic !== prev);
    if (j > i) { const [moved] = out.splice(j, 1); out.splice(i, 0, moved); }
  }
  return out;
}

export function buildRestRoutes(
  lw: Engram, cfg: HarnessConfig, status: Record<string, string | boolean> = {}, anki?: AnkiClient,
) {
  const app = new Hono();

  // Cached (TTL + stale-while-revalidate) — recomputing from every vault page is ~3s live;
  // see src/server/graphCache.ts for the caching contract and mcp.ts for invalidation.
  app.get('/api/graph', async (c) => c.json(await getGraphCached(() => fetchGraph(lw, cfg))));

  // Curated paths — Engram's syllabus primitive. It has existed since the first version
  // (create_path / list_paths / read_path) with NO learner-facing surface at all: the tutor could
  // read a path, the learner could never see one, so a subject had no visible spine and no sense of
  // "how far through am I". These two routes plus the Library's Paths section are that surface.
  app.get('/api/paths', async (c) => {
    const [paths, state] = await Promise.all([
      lw.call('list_paths', {}),
      lw.call('get_student_state', { student: cfg.student }),
    ]);
    const goal = readGoal(cfg.vault);
    const rows = (paths ?? []).map((p: any) => pathProgress(p, state));
    // The resume button read "resume at nn-forward-pass" — a raw slug in learner-facing copy
    // (fresh-eyes audit). Resolve each row's next page to its real title: bounded at one
    // read_page per path, parallel, and null on failure so a missing page degrades back to the
    // slug rather than dropping the button (same contract as resolveNeighbors above).
    const withTitles = await Promise.all(rows.map(async (r: any) => ({
      ...r,
      nextTitle: r.nextSlug
        ? await lw.call('read_page', { slug: r.nextSlug })
          .then((p: any) => (p.page.meta.title as string) ?? null)
          .catch(() => null)
        : null,
    })));
    return c.json({ goal, paths: withTitles });
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
      // The decay countdown, reported BY the memory layer (get_student_state's detail) rather than
      // re-derived here or in the client: daysLeft is null once the standing has slipped or the
      // level has no clock, and slipped says it already dropped a rung. This is the same authority
      // the graph rings (graphLayout) and the review queue read — the page reader is no longer the
      // odd one out re-computing DECAY windows and the rubric walk client-side.
      daysLeft: (d.days_left ?? null) as number | null,
      slipped: !!d.slipped,
      struggled: count('struggled'),
      misconceptions: (d.misconceptions ?? []) as string[],
      // The repairs, from the evidence log's `resolved` field — the misconceptions list correctly
      // forgets a cleared confusion, but the learner deserves to SEE their progress arc: what
      // they used to get wrong, and when they proved they no longer do.
      repaired: (d.evidence ?? [])
        .filter((e: any) => e.resolved)
        .map((e: any) => ({ date: e.date as string, text: e.resolved as string })),
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
    // Which applied blocks could confirm this page, derived from what exists (appliedRoutes.ts) —
    // so the panel can name a route instead of leaving "no exercise has confirmed it" ambiguous
    // between "not done" and "none exists".
    const routes = appliedRoutesFor({ slug, body: page.page?.body ?? '' }, undefined, cfg.vault);
    const noLadder = missingLadder({ slug, domain: page.page?.domain }, undefined, cfg.vault);
    return c.json({ ...page, neighbors, standing, routes, noLadder });
  });
  app.get('/api/student', async (c) =>
    c.json(await lw.call('get_student_state', { student: cfg.student })));

  /**
   * The review queue — what should be reinforced, most urgent first. The spacing loop's missing
   * half: decay windows always ran, but the only way to notice one closing was to go LOOKING at a
   * page or the graph. Optimal review is the system's job, not the learner's vigilance.
   *
   * Two tiers, both straight from engram's own numbers (days_left/slipped are computed where
   * the decay rules live): `slipped` pages already lost a rung and lead the list; `dueSoon` pages
   * are within DUE_SOON_DAYS of losing one. Sorted most-urgent-first, capped — a wall of 40 due
   * items teaches avoidance, not review.
   */
  /**
   * An interleaved plan for one sitting — spacing AND interleaving, the two best-evidenced
   * practice effects, decided by the system instead of left to the learner's mood.
   *
   * Three queues, rotated: due reviews (slipped first — the /api/due ordering), misconception
   * repairs (recorded misconceptions are data nothing acted on until now), and new material
   * (engram's next_lessons — frontier and unmet-prereq picks). Rotation is the interleaving:
   * blocked practice (all review, then all new) is exactly what the rotation exists to prevent.
   * Capped at 6 — a session plan, not a syllabus.
   */
  // Per-item retrieval constraints, carried on the plan so they reach the tutor NEXT TO the row
  // being worked (see the comment where they're attached). Phrased as the concrete method, not a
  // reminder to consult the rulebook: "probe in a new context" is actionable inline.
  const TRANSFER_REVIEW = 'probe in a NEW context — fresh numbers or a different scenario, never the page’s own example — so a pass proves transfer, not memory of one problem';
  const TRANSFER_FIX = 'test the corrected idea somewhere new — a pass has to show the repair generalises, not that they can recite the fix';

  app.get('/api/session-plan', async (c) => {
    const CAP = 6;
    const state = await lw.call('get_student_state', { student: cfg.student }).catch(() => ({})) as Record<string, any>;
    const entries = Object.entries(state).filter(([, m]) => m && typeof m === 'object');

    const review = entries
      .map(([slug, m]) => ({
        slug, daysLeft: (m.days_left ?? null) as number | null, slipped: m.slipped === true,
        level: typeof m.level === 'string' ? m.level : null,
        effective: typeof m.effective === 'string' ? m.effective : null,
      }))
      .filter((e) => e.slipped || (e.daysLeft !== null && e.daysLeft <= 5))
      .sort((a, b) => (a.slipped === b.slipped ? (a.daysLeft ?? 0) - (b.daysLeft ?? 0) : a.slipped ? -1 : 1))
      .map((e) => ({
        kind: 'review' as const, slug: e.slug,
        // Name the DEPTH of the slip when the numbers are there: a page that fell to `exposed` needs
        // reteaching, one still at `practicing` only a probe — so "slipped from practicing to exposed"
        // is a calibration signal for the tutor, where a flat "this has slipped" is not. Falls back to
        // the plain line when level/effective aren't both present or don't actually differ.
        why: e.slipped
          ? (e.level && e.effective && e.level !== e.effective
            ? `slipped from ${e.level} to ${e.effective} — re-earn it`
            : 'this has slipped — re-earn it')
          : `${e.daysLeft}d before it slips`,
        // The transfer directive TRAVELS WITH THE ITEM. Rule 2a-i in the system prompt says the same
        // thing, but it sits ~40 lines from where the tutor works each plan row; carrying the
        // constraint on the item itself puts it next to the work, where it actually gets honoured.
        // This is mechanical DELIVERY of the constraint, not mechanical generation of the exercise —
        // the tutor still mints the probe, but it can no longer silently re-ask the taught example.
        transfer: TRANSFER_REVIEW,
      }));

    const inReview = new Set(review.map((r) => r.slug));
    const misconception = entries
      .filter(([slug, m]) => !inReview.has(slug) && Array.isArray(m.misconceptions) && m.misconceptions.length > 0)
      .map(([slug, m]) => ({
        kind: 'misconception' as const, slug,
        why: `recorded misconception: “${String(m.misconceptions[m.misconceptions.length - 1]).slice(0, 80)}”`,
        // A fix is a re-prove: confirm the repair GENERALISES, not that they can recite the
        // correction. Same co-location argument as review above.
        transfer: TRANSFER_FIX,
      }));

    const taken = new Set([...inReview, ...misconception.map((m) => m.slug)]);
    const lessons = await lw.call('next_lessons', { student: cfg.student, k: CAP })
      .then((r: any) => (Array.isArray(r?.lessons) ? r.lessons : []))
      .catch(() => []);
    const freshAll = lessons
      .filter((l: any) => l?.slug && !taken.has(l.slug))
      .map((l: any) => ({
        kind: 'new' as const, slug: l.slug as string,
        why: l.reason === 'unmet-prereq' ? (l.detail ?? 'a prerequisite on your path') : 'next on your frontier',
      }));
    // Boot-seeded pattern stubs are practice INVENTORY, not the learner's frontier. Without this
    // filter every plan — including a brand-new install's — opened with "Consuming SSE token
    // streams" as "next on your frontier", whatever the learner was actually studying (the
    // cold-start audit caught it). Once evidence exists on a seeded page it reaches the plan the
    // honest way, through the review/misconception queues above; only the 'new' door is closed.
    const freshMeta = await Promise.all(freshAll.map((f: { slug: string }) =>
      lw.call('read_page', { slug: f.slug })
        .then((pg: any) => pg.page?.meta ?? null).catch(() => null)));
    const fresh = freshAll.filter((_: unknown, i: number) => {
      const meta = freshMeta[i];
      if (!meta) return true;
      const seeded = meta.status === 'stub'
        && (Array.isArray(meta.sources) ? meta.sources : [])
          .some((s: unknown) => /^(the-gap artifact|generated exercise) /.test(String(s)));
      return !seeded;
    });

    // Banked course problems nobody has answered yet — a past exam is exactly the material a
    // sitting should touch, but two per plan is the cap: the bank must not crowd out reviews or
    // new work. `slug` is the problem's bank id, not a page — the tutor resolves it through
    // course_problems and drills the text verbatim.
    const course = readBank(cfg.vault)
      .filter((p) => !p.lastCorrect)
      .slice(0, 2)
      .map((p) => ({
        kind: 'course' as const, slug: p.id,
        title: `Problem ${p.n} from ${p.source}`, why: `from ${p.source}`,
      }));

    // BATCH due pages into ONE retrieval block when there are enough of them to swamp a sitting.
    // This is the only thing `quiz` mode's framing sentence ("open with a quiz block covering
    // recent pages") ever actually steered, and the per-page plan cannot express it.
    //
    // The floor is deliberately high. Three due pages is an ordinary review session, and batching
    // those is a LOSS: individual review items each carry their own transfer directive (2a-i) and
    // get spread by topic, where one quiz flattens them into multiple-choice and drops both. Only
    // once probing every page one at a time would consume the whole sitting does a single quiz
    // become the better instrument — and even then it takes a slice, not the queue.
    const QUIZ_FLOOR = 5;
    const QUIZ_BATCH = 4;
    const batched = review.length >= QUIZ_FLOOR ? review.splice(0, QUIZ_BATCH) : [];
    const quiz = batched.length
      ? [{
        kind: 'quiz' as const,
        // The slug is the FIRST page's, so titles and evidence resolve; every covered page is
        // named in `covers`, which the tutor reads to build the item list.
        slug: batched[0].slug,
        covers: batched.map((b) => b.slug),
        why: `${batched.length} of your due pages, quizzed together: ${batched.map((b) => b.slug).join(', ')}`,
        transfer: TRANSFER_REVIEW,
      }]
      : [];

    // The quiz LEADS the review queue rather than replacing it: batching six due pages into one
    // block must not silently drop the seventh, which splicing them out of `review` would do.
    const queues: any[] = [[...quiz, ...review], fresh, course, misconception];
    const plan: { kind: string; slug: string; why: string; title?: string; covers?: string[] }[] = [];
    for (let i = 0; plan.length < CAP && queues.some((q) => q.length > 0); i++) {
      const q = queues[i % queues.length];
      const next = q.shift();
      if (next) plan.push(next);
    }
    // Resolve title AND a topic key in one pass (the read we already do for titles carries the
    // page's tags too, so topic-awareness costs no extra calls). Course entries carry their own
    // title — their slug is a bank id no page resolves — and take the source as their topic so two
    // problems from the same exam don't end up adjacent either.
    const withMeta = await Promise.all(plan.map(async (p) => {
      if (p.title) return { ...p, _topic: `course:${p.why}` };
      const meta = await lw.call('read_page', { slug: p.slug })
        .then((pg: any) => pg.page?.meta ?? null).catch(() => null);
      const tags = Array.isArray(meta?.tags) ? meta.tags : [];
      return { ...p, title: meta?.title ?? p.slug, _topic: tags.length ? String(tags[0]) : undefined };
    }));
    // Separate same-topic neighbours, then drop the internal topic key from the payload.
    const titled = interleaveByTopic(withMeta).map(({ _topic, ...rest }) => rest);
    return c.json({ plan: titled });
  });

  /**
   * The course bank by source, for the Library's Course practice section: how many problems each
   * ingested problem set banked and how many the learner has never answered. Counts only — the
   * problems themselves stay the tutor's to present (verbatim, in a session), not a browsing UI's.
   */
  app.get('/api/course-bank', (c) => {
    const bySource = new Map<string, { source: string; problems: number; fresh: number }>();
    for (const p of readBank(cfg.vault)) {
      const row = bySource.get(p.source) ?? { source: p.source, problems: 0, fresh: 0 };
      row.problems++;
      if (!p.lastCorrect) row.fresh++;
      bySource.set(p.source, row);
    }
    return c.json({ sources: [...bySource.values()] });
  });

  /**
   * Student profiles — the homeschool-parent persona: one vault, several learners, separate
   * evidence. Engram has always keyed evidence by student id; these two routes and the
   * topbar switcher are the missing surface. Switching mutates cfg.student IN PLACE (every
   * handler reads cfg.student per request, so the next request is the new learner) and
   * persists to the config file so a restart keeps it.
   */
  app.get('/api/students', (c) => {
    const dir = join(cfg.vault, 'students');
    const known = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
      : [];
    if (!known.includes(cfg.student)) known.push(cfg.student);
    return c.json({ current: cfg.student, students: known.sort() });
  });
  app.put('/api/student', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body?.name ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-_]{0,39}$/.test(name)) {
      return c.json({ error: 'student names are 1-40 chars: letters, digits, - and _' }, 400);
    }
    cfg.student = name;
    // Persist so a restart keeps the switch. Read-modify-write of the JSON on disk preserves
    // every other field (and any fields this build does not know about).
    try {
      const path = process.env.HARNESS_CONFIG ?? './harness.config.json';
      const onDisk = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
      onDisk.student = name;
      writeFileSync(path, `${JSON.stringify(onDisk, null, 2)}\n`);
    } catch (e: any) {
      // The in-memory switch already took effect; a failed persist is named, not hidden.
      return c.json({ current: name, warning: `switched for this run, but not saved: ${e?.message ?? e}` });
    }
    return c.json({ current: name });
  });

  /** The teaching-style preference, settable from the student menu. Same in-place +
   *  read-modify-write persistence as /api/student; empty string clears it. */
  app.put('/api/voice', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const voice = String(body?.voice ?? '').trim().slice(0, 200);
    (cfg as any).voice = voice || undefined;
    try {
      const path = process.env.HARNESS_CONFIG ?? './harness.config.json';
      const onDisk = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
      if (voice) onDisk.voice = voice; else delete onDisk.voice;
      writeFileSync(path, JSON.stringify(onDisk, null, 2) + '\n');
    } catch (e: any) {
      return c.json({ voice, warning: 'set for this run, but not saved: ' + (e?.message ?? e) });
    }
    return c.json({ voice });
  });
  app.get('/api/voice', (c) => c.json({ voice: (cfg as any).voice ?? '' }));

  /**
   * The raw ingested artifact, for the source reader — the surface where "the tutor brings you
   * to a source and you query ON it" happens. Serves only files under vault/raw/ (the ledger's
   * `chapter` paths), resolved and prefix-checked so a crafted path cannot escape the vault.
   */
  app.get('/api/source', (c) => {
    const rel = c.req.query('path') ?? '';
    if (!rel.startsWith('raw/')) return c.json({ error: 'only raw/ source paths are served' }, 400);
    const rawRoot = resolve(cfg.vault, 'raw');
    const target = resolve(cfg.vault, rel);
    if (target !== rawRoot && !target.startsWith(rawRoot + '/')) {
      return c.json({ error: 'path escapes the vault' }, 400);
    }
    try {
      // realpath after the prefix check: a symlink inside raw/ pointing outside must not win.
      const real = realpathSync(target);
      if (real !== rawRoot && !real.startsWith(realpathSync(rawRoot) + '/')) {
        return c.json({ error: 'path escapes the vault' }, 400);
      }
      return c.json({ markdown: readFileSync(real, 'utf8') });
    } catch {
      return c.json({ error: 'no such source' }, 404);
    }
  });

  // Title with slug fallback — the one resolution path for every list that names pages (/api/due,
  // /api/horizon, /api/progress's nextSlip): a page that fails to resolve keeps its slug rather
  // than dropping off the list.
  const pageTitle = (slug: string): Promise<string> =>
    lw.call('read_page', { slug })
      .then((p: any) => (p.page?.meta?.title as string) ?? slug)
      .catch(() => slug);

  app.get('/api/due', async (c) => {
    const DUE_SOON_DAYS = 5;
    const CAP = 12;
    const state = await lw.call('get_student_state', { student: cfg.student }) as Record<string, any>;
    const entries = Object.entries(state)
      .filter(([, m]) => m && typeof m === 'object')
      .map(([slug, m]) => ({
        slug,
        level: m.level as string,
        effective: m.effective as string,
        daysLeft: (m.days_left ?? null) as number | null,
        slipped: m.slipped === true,
      }))
      .filter((e) => e.slipped || (e.daysLeft !== null && e.daysLeft <= DUE_SOON_DAYS))
      .sort((a, b) => (a.slipped === b.slipped ? (a.daysLeft ?? 0) - (b.daysLeft ?? 0) : a.slipped ? -1 : 1));
    // `total` before the cap: the cap keeps the LIST humane, but hiding that more exist — and a
    // badge reading 12 when 15 have slipped — is a silent lie the load test caught.
    const total = entries.length;
    const capped = entries.slice(0, CAP);
    // Titles resolved per due page — bounded by the cap.
    const due = await Promise.all(capped.map(async (e) => ({ ...e, title: await pageTitle(e.slug) })));
    return c.json({ due, total });
  });
  /**
   * The whole decay landscape — every page with a standing, not just the slice that needs review
   * now. /api/due answers "what is urgent" and caps the list; this answers "where does everything
   * stand", healthy pages included, so a landscape view can show the long-safe alongside the
   * slipping. Levels are EFFECTIVE (decay-adjusted, as get_student_state reports them); a page
   * whose effective level is unseen has no standing to show.
   */
  app.get('/api/horizon', async (c) => {
    const state = await lw.call('get_student_state', { student: cfg.student }) as Record<string, any>;
    const entries = Object.entries(state)
      .filter(([, m]) => m && typeof m === 'object')
      .map(([slug, m]) => ({
        slug,
        level: m.effective as string,
        daysLeft: (m.days_left ?? null) as number | null,
        slipped: m.slipped === true,
      }))
      .filter((e) => e.level && e.level !== 'unseen')
      // Slipped leads (the /api/due promise), then the tightest countdown. A null daysLeft on an
      // UNSLIPPED page means no clock at all — exposed, nothing to lose — which is the least
      // urgent thing here, so nulls sort last rather than borrowing 0's urgency.
      .sort((a, b) => {
        if (a.slipped !== b.slipped) return a.slipped ? -1 : 1;
        if (a.daysLeft === null) return b.daysLeft === null ? 0 : 1;
        if (b.daysLeft === null) return -1;
        return a.daysLeft - b.daysLeft;
      });
    const pages = await Promise.all(entries.map(async (e) => ({ ...e, title: await pageTitle(e.slug) })));
    return c.json({ pages });
  });
  // An HONEST progress read — no points, no streaks, just what's true and what it implies. Three
  // numbers a learner can act on: what they actually know now (by decayed level), what they earned
  // recently (motivating BECAUSE it's real graded evidence, not activity), and what's slipping (the
  // decay framed as a 10-minute opportunity to lock gains back in, not a punishment).
  app.get('/api/progress', async (c) => {
    // Level breakdown + slipping come from get_student_state, which applies the decay rules — so
    // "mastered/practicing/exposed" here mean what the learner knows NOW, not what they once did.
    const state = await lw.call('get_student_state', { student: cfg.student }) as Record<string, any>;
    const byLevel = { mastered: 0, practicing: 0, exposed: 0 };
    let slipping = 0;
    // The not-yet-slipped page whose decay window closes soonest — the one CONCRETE page to review
    // next, where `slipping` only says how many already fell. Slipped pages are excluded (their
    // countdown is over; they are the `slipping` number), as are pages with no clock at all.
    let nextSlipEntry: { slug: string; daysLeft: number } | null = null;
    for (const [slug, m] of Object.entries(state)) {
      if (!m || typeof m !== 'object') continue;
      const eff = (m as any).effective as string;
      if (eff === 'mastered') byLevel.mastered += 1;
      else if (eff === 'practicing') byLevel.practicing += 1;
      else if (eff === 'exposed') byLevel.exposed += 1;
      if ((m as any).slipped === true) slipping += 1;
      else {
        const daysLeft = (m as any).days_left;
        if (typeof daysLeft === 'number' && (nextSlipEntry === null || daysLeft < nextSlipEntry.daysLeft)) {
          nextSlipEntry = { slug, daysLeft };
        }
      }
    }
    // "Earned this week" needs per-evidence DATES, which the bulk get_student_state omits (it sends
    // evidenceCount, not the array — that's only in the per-slug detail). Read the student ledger
    // file directly, the same vault the source reader already reads from, and count only POSITIVE
    // graded evidence in the last 7 days — the kinds that move mastery, so the number means
    // learning shown, not time spent. Format drift or no ledger yet → 0, and the card still shows
    // the level/slipping it got from the state call.
    let earnedThisWeek = 0;
    // TODAY's evidence by outcome, from the same per-evidence dates. `repaired` counts entries
    // carrying a `resolved` field — engram's applyEvidence stamps the cleared misconception's text
    // there, and that entry's own kind is ALSO counted, so a repair that came through an applied
    // check shows in both. The date is rendered the way engram stamps every evidence date
    // (toISOString, off the same clock earnedThisWeek's cutoff reads), so string equality is exact.
    const today = { applied: 0, explained: 0, rubric: 0, struggled: 0, repaired: 0 };
    // Calibration, from the same ledger walk: quick_check's confidence toggle stamps " · felt
    // sure"/" · felt unsure" onto the evidence note (grading.ts), so "of the answers you called
    // sure, how many were right" is countable with no new storage. All-time, not windowed —
    // calibration is a trait being measured, not this week's activity. `includes('felt sure')`
    // cannot match "felt unsure" (the space before 's' breaks it). Null until any sure-rating
    // exists, so the card can tell "no data" from "0 for 0".
    let sureRight = 0;
    let sureTotal = 0;
    try {
      const ledgerPath = resolve(cfg.vault, 'students', `${cfg.student}.json`);
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<string, any>;
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const todayStr = new Date().toISOString().slice(0, 10);
      const POSITIVE = new Set(['applied-correctly', 'explained-correctly', 'rubric-passed']);
      for (const m of Object.values(ledger)) {
        for (const e of ((m as any)?.evidence ?? []) as any[]) {
          if (POSITIVE.has(e?.kind) && e?.date && new Date(`${e.date}T00:00:00Z`) >= cutoff) earnedThisWeek += 1;
          if (typeof e?.note === 'string' && e.note.includes('felt sure')) {
            sureTotal += 1;
            if (POSITIVE.has(e?.kind)) sureRight += 1;
          }
          if (e?.date !== todayStr) continue;
          if (e.kind === 'applied-correctly') today.applied += 1;
          else if (e.kind === 'explained-correctly') today.explained += 1;
          else if (e.kind === 'rubric-passed') today.rubric += 1;
          else if (e.kind === 'struggled') today.struggled += 1;
          if (e.resolved) today.repaired += 1;
        }
      }
    } catch { /* no ledger yet, or a format change — 0 earned/today, the rest of the card still stands */ }
    const nextSlip = nextSlipEntry === null
      ? null
      : { ...nextSlipEntry, title: await pageTitle(nextSlipEntry.slug) };
    const calibration = sureTotal > 0 ? { sureRight, sureTotal } : null;
    return c.json({ byLevel, slipping, earnedThisWeek, today, nextSlip, calibration });
  });
  // Token spend per role, from the usage ledger every model call appends to (usageLedger.ts):
  // today's and the trailing week's per-role totals, plus the window's cache-hit share of input.
  app.get('/api/usage', (c) => c.json(readUsage(cfg.vault)));

  app.get('/api/status', async (c) => {
    // Read the tutor model AND the student from cfg HERE, not from the snapshot passed in at boot.
    // Switching learners rewrites cfg.student while the app runs (PUT /api/student). A captured
    // value reverted the displayed learner to the boot-time one on the next 60s poll — the
    // switcher bug this fixes — even though /api/students and /api/progress had already moved to
    // the new student.
    const extra: Record<string, string> = { tutor: cfg.models.tutor.model, student: cfg.student };
    if (anki) {
      const up = await anki.isUp();
      // Number.isFinite: backlogDays is Infinity when Anki has NEVER synced — which is every
      // fresh install (the client is constructed unconditionally). Infinity > nudge-days read
      // as 'backlog', so a brand-new machine with no Anki at all wore an amber "Anki has a
      // review backlog" badge about work that never existed. No sync yet = nothing to have a
      // backlog of = 'down' (which the topbar deliberately hides).
      const days = backlogDays(cfg.vault);
      const backlog = !up && Number.isFinite(days) && days > cfg.schedule.ankiBacklogNudgeDays;
      extra.anki = up ? 'up' : backlog ? 'backlog' : 'down';
    }
    // Unconditional: code exercises run in-process (gap/service.ts), so this is always up.
    extra.gap = (await isGapUp()) ? 'up' : 'down';
    return c.json({ ...status, ...extra });
  });
  return app;
}
