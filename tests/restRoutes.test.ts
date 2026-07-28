import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRestRoutes } from '../src/server/restRoutes.js';
import { invalidateGraphCache } from '../src/server/graphCache.js';
import { saveProblems, markCorrect } from '../src/server/courseBank.js';
import type { HarnessConfig } from '../src/server/config.js';

const TTL_MS = 60_000;

/** Flush pending microtasks (native Promise resolution — NOT gated by fake timers, which only
 * fake macrotasks like setTimeout/Date) so an un-awaited background refresh gets a chance to
 * finish before we assert on it. */
async function tick(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// compileNext/route tests elsewhere (tests/ingestRepo.test.ts, tests/ingestRoutes.test.ts) use the
// same shape of plain-object stub for the Loreweaver client — a real MCP round-trip for
// GET /api/graph is already covered by tests/mcp.test.ts.
function fakeLw(opts: { slugs?: string[]; fail?: () => boolean } = {}) {
  const { slugs = ['a'], fail = () => false } = opts;
  // The fetch counter keys off the whole-map get_student_state call — the one call EVERY
  // fetchGraph path makes, and makes first. (It used to key off listSlugs, which the
  // list_pages fast path no longer touches.)
  let fetchCalls = 0;
  const lw = {
    listSlugs: async () => {
      if (fail()) throw new Error('lw down');
      return slugs;
    },
    call: async (name: string, args: any) => {
      if (name === 'get_student_state' && args.slug === undefined) {
        fetchCalls++;
        if (fail()) throw new Error('lw down');
        // Tag the response with the fetch number so tests can tell a fresh fetch's payload
        // apart from a stale one without inspecting mocks.
        return { detail: null, fetchNum: fetchCalls };
      }
      if (fail()) throw new Error('lw down');
      if (name === 'get_student_state') return { detail: null };
      if (name === 'list_pages') {
        return { pages: slugs.map((slug) => ({ slug, title: slug, difficulty: 1, status: 'stub', prereqs: [], deepens: [] })) };
      }
      if (name === 'read_page') {
        return { page: { meta: { title: args.slug, difficulty: 1, status: 'stub', prereqs: [], deepens: [] } } };
      }
      throw new Error(`fakeLw: unexpected call ${name}`);
    },
  } as any;
  return { lw, listSlugsCalls: () => fetchCalls };
}

const cfg = { student: 'kid' } as HarnessConfig;

beforeEach(() => { invalidateGraphCache(); });
afterEach(() => { vi.useRealTimers(); });

describe('GET /api/graph caching', () => {
  it('cold call hits lw once', async () => {
    const { lw, listSlugsCalls } = fakeLw();
    const app = buildRestRoutes(lw, cfg);
    const res = await app.request('/api/graph');
    expect(res.status).toBe(200);
    expect(listSlugsCalls()).toBe(1);
  });

  it('second call within TTL serves cache without a second lw call', async () => {
    const { lw, listSlugsCalls } = fakeLw();
    const app = buildRestRoutes(lw, cfg);
    const first = await (await app.request('/api/graph')).json();
    const second = await (await app.request('/api/graph')).json();
    expect(second).toEqual(first);
    expect(listSlugsCalls()).toBe(1);
  });

  it('a failed cold-cache call surfaces the error, as today', async () => {
    const { lw, listSlugsCalls } = fakeLw({ fail: () => true });
    const app = buildRestRoutes(lw, cfg);
    const res = await app.request('/api/graph');
    expect(res.status).toBe(500); // Hono's default: an uncaught handler error becomes a 500
    expect(listSlugsCalls()).toBe(1);
  });

  it('after TTL expiry, the stale payload returns instantly while exactly ONE refresh fires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { lw, listSlugsCalls } = fakeLw();
    const app = buildRestRoutes(lw, cfg);

    const cold = await (await app.request('/api/graph')).json();
    expect(cold.summary.fetchNum).toBe(1);
    expect(listSlugsCalls()).toBe(1);

    vi.setSystemTime(TTL_MS + 1); // now stale

    // Two concurrent requests while stale must dedup to exactly one background refresh.
    const [r1, r2] = await Promise.all([app.request('/api/graph'), app.request('/api/graph')]);
    const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
    expect(b1).toEqual(cold); // stale payload served immediately, unchanged
    expect(b2).toEqual(cold);

    await tick(); // let the single background refresh resolve
    expect(listSlugsCalls()).toBe(2); // exactly one refresh fired, not one per concurrent request

    // Next request after the refresh landed sees the fresh payload, cache hit (no third lw hit).
    const after = await (await app.request('/api/graph')).json();
    expect(after.summary.fetchNum).toBe(2);
    expect(listSlugsCalls()).toBe(2);
  });

  it('invalidateGraphCache forces the next call to refetch', async () => {
    const { lw, listSlugsCalls } = fakeLw();
    const app = buildRestRoutes(lw, cfg);
    await app.request('/api/graph');
    expect(listSlugsCalls()).toBe(1);

    invalidateGraphCache();

    const res = await (await app.request('/api/graph')).json();
    expect(res.summary.fetchNum).toBe(2);
    expect(listSlugsCalls()).toBe(2);
  });

  it('a failed background refresh logs once and keeps serving the stale cache', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let shouldFail = false;
    const { lw, listSlugsCalls } = fakeLw({ fail: () => shouldFail });
    const app = buildRestRoutes(lw, cfg);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const cold = await (await app.request('/api/graph')).json();

    vi.setSystemTime(TTL_MS + 1);
    shouldFail = true;
    const stale = await (await app.request('/api/graph')).json();
    expect(stale).toEqual(cold); // still the old payload, served without waiting

    await tick();
    expect(listSlugsCalls()).toBe(2); // the failed refresh attempt did happen
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/\[graphCache\]/);

    // Cache isn't corrupted by the failure — still serves the last-good payload right after.
    // (lw is still failing here, so this call also kicks off — and loses — its own retry; that's
    // covered below rather than asserted on here, to keep this assertion about the failure itself.)
    shouldFail = false; // let the NEXT refresh attempt succeed before making that next call

    const recovering = await (await app.request('/api/graph')).json();
    expect(recovering).toEqual(cold); // still stale-serve — the refresh hasn't landed yet
    await tick();
    expect(listSlugsCalls()).toBe(3); // one more attempt, this time it succeeds
    expect(errorSpy).toHaveBeenCalledTimes(1); // no new error logged for the successful retry

    const recovered = await (await app.request('/api/graph')).json();
    expect(recovered.summary.fetchNum).toBe(3); // fresh cache now serves the recovered payload
    expect(listSlugsCalls()).toBe(3); // served from cache, no extra lw hit

    errorSpy.mockRestore();
  });
});

// ── GET /api/page/:slug neighbour resolution ─────────────────────────────────
//
// The Page panel renders edges with a title and the learner's mastery on each neighbour. Those two
// facts are resolved server-side, and every case below is one the panel would otherwise get wrong:
// a neighbour with no page behind it, an IN edge (whose slug is `src`, not `dst`), and a neighbour
// the student has never seen.

/** Stub of a vault with `pages` present and `edges` on the page under test. */
function pageLw(opts: {
  slug: string;
  edges: { in?: any[]; out?: any[] };
  pages: Record<string, string>;
  student?: Record<string, { effective: string }>;
}) {
  let readPageCalls = 0;
  let studentCalls = 0;
  const lw = {
    listSlugs: async () => Object.keys(opts.pages),
    call: async (name: string, args: any) => {
      if (name === 'get_student_state') { studentCalls++; return opts.student ?? {}; }
      if (name === 'read_page') {
        readPageCalls++;
        if (args.slug === opts.slug) {
          return {
            page: { slug: opts.slug, domain: 'calculus', meta: { title: opts.pages[opts.slug] }, body: 'b', warnings: [] },
            edges: { in: opts.edges.in ?? [], out: opts.edges.out ?? [] },
          };
        }
        const title = opts.pages[args.slug];
        // Mirrors the real tool: a slug with no page is an error, not an empty page.
        if (title === undefined) throw new Error(`loreweaver read_page: page not found: ${args.slug}`);
        return { page: { slug: args.slug, meta: { title } }, edges: { in: [], out: [] } };
      }
      throw new Error(`pageLw: unexpected call ${name}`);
    },
  } as any;
  return { lw, readPageCalls: () => readPageCalls, studentCalls: () => studentCalls };
}

describe('GET /api/page/:slug neighbours', () => {
  it('resolves titles and effective mastery for out- and in-edges alike', async () => {
    const { lw } = pageLw({
      slug: 'chain-rule',
      pages: { 'chain-rule': 'Chain Rule', derivatives: 'Derivatives', 'implicit-diff': 'Implicit Differentiation' },
      edges: {
        out: [{ dst: 'derivatives', type: 'prereq', rationale: 'you differentiate the outer fn' }],
        in: [{ src: 'implicit-diff', type: 'prereq' }],
      },
      student: { derivatives: { effective: 'mastered' }, 'implicit-diff': { effective: 'exposed' } },
    });
    const body = await (await buildRestRoutes(lw, cfg).request('/api/page/chain-rule')).json();

    expect(body.neighbors).toEqual({
      derivatives: { title: 'Derivatives', mastery: 'mastered' },
      // An IN edge carries its neighbour on `src`. Reading `dst` here would resolve the page's own
      // slug and the panel would render "Chain Rule" as its own prerequisite.
      'implicit-diff': { title: 'Implicit Differentiation', mastery: 'exposed' },
    });
    // The original read_page payload is passed through untouched, rationale included.
    expect(body.edges.out[0].rationale).toBe('you differentiate the outer fn');
    expect(body.page.meta.title).toBe('Chain Rule');
  });

  it('reports a neighbour with no page as title null instead of dropping it', async () => {
    const { lw } = pageLw({
      slug: 'chain-rule',
      pages: { 'chain-rule': 'Chain Rule' },
      edges: { out: [{ dst: 'limits', type: 'prereq' }] },
    });
    const body = await (await buildRestRoutes(lw, cfg).request('/api/page/chain-rule')).json();
    // Dropping it would hide a real hole in the vault: a declared prereq nobody has written.
    expect(body.neighbors).toEqual({ limits: { title: null, mastery: null } });
  });

  it('gives a never-seen neighbour null mastery rather than inventing a level', async () => {
    const { lw } = pageLw({
      slug: 'chain-rule',
      pages: { 'chain-rule': 'Chain Rule', derivatives: 'Derivatives' },
      edges: { out: [{ dst: 'derivatives', type: 'prereq' }] },
      student: {},
    });
    const body = await (await buildRestRoutes(lw, cfg).request('/api/page/chain-rule')).json();
    expect(body.neighbors.derivatives).toEqual({ title: 'Derivatives', mastery: null });
  });

  it('costs one read_page per DISTINCT neighbour and one student call, not one per edge', async () => {
    const { lw, readPageCalls, studentCalls } = pageLw({
      slug: 'chain-rule',
      pages: { 'chain-rule': 'Chain Rule', derivatives: 'Derivatives' },
      // Same neighbour reached by two different edge types — a real shape (a page can both require
      // and mention another). Resolving it twice would double the cost for no new information.
      edges: {
        out: [{ dst: 'derivatives', type: 'prereq' }, { dst: 'derivatives', type: 'related' }],
      },
    });
    await buildRestRoutes(lw, cfg).request('/api/page/chain-rule');
    expect(readPageCalls()).toBe(2); // the page itself + one neighbour
    // Two student calls, both bounded and independent of edge count: one BULK call for every
    // neighbour's mastery, and one PER-SLUG call for this page's own standing (which needs the
    // evidence log, and the bulk response does not carry it).
    expect(studentCalls()).toBe(2);
  });

  it('skips the whole resolution for a page with no edges', async () => {
    const { lw, readPageCalls, studentCalls } = pageLw({
      slug: 'chain-rule', pages: { 'chain-rule': 'Chain Rule' }, edges: {},
    });
    const body = await (await buildRestRoutes(lw, cfg).request('/api/page/chain-rule')).json();
    expect(body.neighbors).toEqual({});
    expect(readPageCalls()).toBe(1);
    // No neighbours means no BULK mastery lookup, but the page's own standing is still fetched —
    // a page with no edges is exactly as entitled to "how did I earn this level" as any other.
    expect(studentCalls()).toBe(1);
  });

  it('does not resolve the page as its own neighbour', async () => {
    const { lw } = pageLw({
      slug: 'chain-rule',
      pages: { 'chain-rule': 'Chain Rule' },
      // buildEdges drops self-edges, but read_page is not the only possible source of this payload
      // and rendering a page as its own prerequisite would be an obvious lie.
      edges: { out: [{ dst: 'chain-rule', type: 'related' }] },
    });
    const body = await (await buildRestRoutes(lw, cfg).request('/api/page/chain-rule')).json();
    expect(body.neighbors).toEqual({});
  });

  it('still serves the page when the student state call fails', async () => {
    const lw = {
      listSlugs: async () => ['chain-rule'],
      call: async (name: string, args: any) => {
        if (name === 'get_student_state') throw new Error('student file unreadable');
        if (args.slug === 'chain-rule') {
          return {
            page: { slug: 'chain-rule', meta: { title: 'Chain Rule' }, body: 'b', warnings: [] },
            edges: { in: [], out: [{ dst: 'derivatives', type: 'prereq' }] },
          };
        }
        return { page: { slug: args.slug, meta: { title: 'Derivatives' } } };
      },
    } as any;
    const res = await buildRestRoutes(lw, cfg).request('/api/page/chain-rule');
    expect(res.status).toBe(200);
    // Losing mastery is a degraded panel; losing the page is a broken one. Titles still resolve.
    expect((await res.json()).neighbors).toEqual({ derivatives: { title: 'Derivatives', mastery: null } });
  });
});

describe('GET /api/page/:slug for a page that does not exist', () => {
  const missingLw = {
    listSlugs: async () => [],
    // Mirrors read_page's own wording, routed through lw.call's throw-on-isError.
    call: async () => { throw new Error('loreweaver read_page: page not found: ghost'); },
  } as any;

  it('answers 404, not 500', async () => {
    const res = await buildRestRoutes(missingLw, cfg).request('/api/page/ghost');
    // A dangling wiki-link is the most ordinary thing a typed graph produces — Loreweaver models it
    // (`missingTargets`) — so it must not be reported to the learner as a harness malfunction.
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/no page for/i);
  });

  it('still propagates a genuine failure as a 500', async () => {
    const brokenLw = {
      listSlugs: async () => [],
      call: async () => { throw new Error('loreweaver read_page: ENOSPC writing index'); },
    } as any;
    // Blanket-catching would have turned every backend fault into a soothing "not written yet".
    const res = await buildRestRoutes(brokenLw, cfg).request('/api/page/ghost');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/due and /api/session-plan', () => {
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);

  function spacedLw() {
    const state: Record<string, any> = {
      // slipped: practicing, window passed, loreweaver reports slipped=true, days_left=null
      slipped: { level: 'practicing', effective: 'exposed', last_reinforced: day(25), days_left: null, slipped: true, misconceptions: [] },
      // due soon
      soon: { level: 'practicing', effective: 'practicing', last_reinforced: day(19), days_left: 2, slipped: false, misconceptions: [] },
      // healthy — must appear in neither list
      healthy: { level: 'mastered', effective: 'mastered', last_reinforced: day(5), days_left: 40, slipped: false, misconceptions: [] },
      // healthy but with a recorded misconception — session plan's repair queue
      confused: { level: 'practicing', effective: 'practicing', last_reinforced: day(2), days_left: 19, slipped: false, misconceptions: ['mixes up X with Y'] },
    };
    return {
      listSlugs: async () => Object.keys(state),
      call: async (name: string, args: any) => {
        if (name === 'get_student_state') return state;
        if (name === 'read_page') return { page: { meta: { title: `T:${args.slug}` } } };
        if (name === 'next_lessons') {
          return { lessons: [{ slug: 'fresh-one', reason: 'frontier' }, { slug: 'slipped', reason: 'review-due' }] };
        }
        throw new Error(`unexpected call ${name}`);
      },
    } as any;
  }

  it('/api/due: slipped leads, healthy excluded, titles resolved', async () => {
    const app = buildRestRoutes(spacedLw(), cfg);
    const { due, total } = await (await app.request('/api/due')).json();
    expect(due.map((d: any) => d.slug)).toEqual(['slipped', 'soon']);
    expect(total).toBe(2); // pre-cap count — the badge's number, honest under load
    expect(due[0].slipped).toBe(true);
    expect(due[0].title).toBe('T:slipped');
  });

  it('/api/session-plan interleaves review, new and misconception queues without duplicates', async () => {
    const app = buildRestRoutes(spacedLw(), cfg);
    const { plan } = await (await app.request('/api/session-plan')).json();
    expect(plan.map((p: any) => `${p.kind}:${p.slug}`)).toEqual([
      'review:slipped',       // most urgent leads
      'new:fresh-one',        // rotation to the new queue; 'slipped' from next_lessons deduped
      'misconception:confused',
      'review:soon',
    ]);
    expect(plan.find((p: any) => p.kind === 'misconception').why).toContain('mixes up X with Y');
  });

  it('/api/session-plan never offers an untouched boot-seeded stub as "new"', async () => {
    // The cold-start audit: a fresh install's plan opened with "Consuming SSE token streams" —
    // the pattern-page seed — as "next on your frontier". Seeded stubs are practice inventory;
    // they enter the plan only after evidence exists on them (via review/misconception).
    const lw = {
      listSlugs: async () => [],
      call: async (name: string, args: any) => {
        if (name === 'get_student_state') return {}; // brand-new learner, no evidence at all
        if (name === 'next_lessons') {
          return { lessons: [{ slug: 'stream-consumer', reason: 'frontier' }, { slug: 'chosen-topic', reason: 'frontier' }] };
        }
        if (name === 'read_page') {
          if (args.slug === 'stream-consumer') {
            return { page: { meta: { title: 'Consuming SSE token streams', status: 'stub', sources: ['the-gap artifact stream-consumer'] } } };
          }
          // A learner-driven stub (e.g. planned by a path) keeps its place in the plan.
          return { page: { meta: { title: 'Chosen Topic', status: 'stub', sources: ['tutor'] } } };
        }
        throw new Error(`unexpected call ${name}`);
      },
    } as any;
    const { plan } = await (await buildRestRoutes(lw, cfg).request('/api/session-plan')).json();
    expect(plan.map((p: any) => p.slug)).toEqual(['chosen-topic']);
  });

  describe('course-bank entries', () => {
    function bankedCfg(problems: { n: number; text: string }[]) {
      const vault = mkdtempSync(join(tmpdir(), 'lwh-plan-bank-'));
      saveProblems(vault, 'midterm-2', problems);
      return { ...cfg, vault } as HarnessConfig;
    }

    it('rotates in up to TWO never-answered bank problems as [course] items, with their own titles', async () => {
      const bcfg = bankedCfg([1, 2, 3, 4].map((n) => ({ n, text: `problem ${n}` })));
      const { plan } = await (await buildRestRoutes(spacedLw(), bcfg).request('/api/session-plan')).json();
      const course = plan.filter((p: any) => p.kind === 'course');
      expect(course.map((p: any) => p.slug)).toEqual(['midterm-2#1', 'midterm-2#2']); // capped at 2
      expect(course[0].why).toBe('from midterm-2');
      // Bank ids resolve to no page — the title must come from the bank, not a read_page fallback.
      expect(course[0].title).toBe('Problem 1 from midterm-2');
    });

    it('answered problems stay out — only never-answered ones enter the plan', async () => {
      const bcfg = bankedCfg([{ n: 1, text: 'a' }, { n: 2, text: 'b' }]);
      markCorrect(bcfg.vault, 'midterm-2#1');
      const { plan } = await (await buildRestRoutes(spacedLw(), bcfg).request('/api/session-plan')).json();
      expect(plan.filter((p: any) => p.kind === 'course').map((p: any) => p.slug)).toEqual(['midterm-2#2']);
    });
  });
});

describe('GET /api/course-bank', () => {
  const lw = { listSlugs: async () => [], call: async () => ({}) } as any;

  it('reports per-source problem and never-answered counts', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-bank-route-'));
    saveProblems(vault, 'midterm-2', [{ n: 1, text: 'a' }, { n: 2, text: 'b' }]);
    saveProblems(vault, 'pset-7', [{ n: 1, text: 'c' }]);
    markCorrect(vault, 'midterm-2#1');
    const app = buildRestRoutes(lw, { ...cfg, vault } as HarnessConfig);
    const { sources } = await (await app.request('/api/course-bank')).json();
    expect(sources).toEqual([
      { source: 'midterm-2', problems: 2, fresh: 1 },
      { source: 'pset-7', problems: 1, fresh: 1 },
    ]);
  });

  it('an empty bank answers an empty list, not an error', async () => {
    const app = buildRestRoutes(lw, cfg); // cfg has no vault at all — readBank's guard case
    const { sources } = await (await app.request('/api/course-bank')).json();
    expect(sources).toEqual([]);
  });
});

describe('GET /api/status — the anki badge tells the truth', () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  const lw = { listSlugs: async () => [], call: async () => ({}) } as any;
  const ankiDown = { isUp: async () => false } as any;
  let vault: string;
  beforeEach(() => { vault = mkdtempSync(join(tmpdir(), 'lwh-status-')); });
  afterEach(() => { rmSync(vault, { recursive: true, force: true }); });
  const cfgWith = (v: string) => ({
    student: 'kid', vault: v,
    models: { tutor: { model: 'm' } }, schedule: { ankiBacklogNudgeDays: 3 },
  } as unknown as HarnessConfig);

  it('never-synced is DOWN, not backlog — a fresh install has no backlog to nudge about', async () => {
    // backlogDays() is Infinity with no sync cursor, and Infinity > nudgeDays wore the amber
    // "Anki has a review backlog" badge on every brand-new machine (cold-start audit).
    const res = await buildRestRoutes(lw, cfgWith(vault), {}, ankiDown).request('/api/status');
    expect((await res.json()).anki).toBe('down');
  });

  it('a genuinely stale sync cursor still reports backlog', async () => {
    mkdirSync(join(vault, '.harness'), { recursive: true });
    writeFileSync(join(vault, '.harness', 'anki-map.json'),
      JSON.stringify({ _cursor: Date.now() - 10 * 86_400_000 }));
    const res = await buildRestRoutes(lw, cfgWith(vault), {}, ankiDown).request('/api/status');
    expect((await res.json()).anki).toBe('backlog');
  });
});

describe('GET /api/source — the reader is served only vault raw files', () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  const lw = { listSlugs: async () => [], call: async () => ({}) } as any;
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'lwh-src-'));
    mkdirSync(join(vault, 'raw', 'uploads', 'attn'), { recursive: true });
    writeFileSync(join(vault, 'raw', 'uploads', 'attn', 'paper.md'), '# Attention\n\nis all you need');
    writeFileSync(join(vault, 'secret.md'), 'not served');
  });
  afterEach(() => { rmSync(vault, { recursive: true, force: true }); });
  const app = () => buildRestRoutes(lw, { student: 'kid', vault } as unknown as HarnessConfig);

  it('serves a ledger chapter path', async () => {
    const res = await app().request('/api/source?path=raw%2Fuploads%2Fattn%2Fpaper.md');
    expect(res.status).toBe(200);
    expect((await res.json()).markdown).toContain('is all you need');
  });

  it('refuses paths outside raw/ and traversal attempts', async () => {
    expect((await app().request('/api/source?path=secret.md')).status).toBe(400);
    expect((await app().request('/api/source?path=raw%2F..%2Fsecret.md')).status).toBe(400);
  });

  it('a missing file is a 404, not a crash', async () => {
    expect((await app().request('/api/source?path=raw%2Fuploads%2Fnope.md')).status).toBe(404);
  });

  it('a symlink inside raw/ pointing outside the vault does not win', async () => {
    // The prefix check passes (the PATH is inside raw/) — only the realpath re-check catches
    // this. The route's own comment promises it; this is the promise, held.
    const { symlinkSync } = require('node:fs') as typeof import('node:fs');
    symlinkSync(join(vault, 'secret.md'), join(vault, 'raw', 'uploads', 'sneaky.md'));
    const res = await app().request('/api/source?path=raw%2Fuploads%2Fsneaky.md');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/escapes the vault/);
  });
});

describe('student profiles — one vault, several learners', () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  const lw = { listSlugs: async () => [], call: async () => ({}) } as any;
  let vault: string; let cfgFile: string; let prevEnv: string | undefined;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'lwh-students-'));
    mkdirSync(join(vault, 'students'), { recursive: true });
    writeFileSync(join(vault, 'students', 'alice.json'), '{}');
    cfgFile = join(vault, 'harness.config.json');
    writeFileSync(cfgFile, JSON.stringify({ student: 'alice', keep: 'me' }));
    prevEnv = process.env.HARNESS_CONFIG;
    process.env.HARNESS_CONFIG = cfgFile;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.HARNESS_CONFIG;
    else process.env.HARNESS_CONFIG = prevEnv;
    rmSync(vault, { recursive: true, force: true });
  });
  const mkCfg = () => ({ student: 'alice', vault } as unknown as HarnessConfig);

  it('lists known students including the current one', async () => {
    const res = await buildRestRoutes(lw, mkCfg()).request('/api/students');
    const body = await res.json();
    expect(body.current).toBe('alice');
    expect(body.students).toContain('alice');
  });

  it('switching mutates cfg in place and persists without clobbering other fields', async () => {
    const cfg = mkCfg();
    const res = await buildRestRoutes(lw, cfg).request('/api/student', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bobby' }),
    });
    expect((await res.json()).current).toBe('bobby'); // case-folded
    expect((cfg as any).student).toBe('bobby');       // in place — next request is bobby's
    const onDisk = JSON.parse(readFileSync(cfgFile, 'utf8'));
    expect(onDisk.student).toBe('bobby');
    expect(onDisk.keep).toBe('me');                   // read-modify-write preserved the rest
  });

  it('rejects names that could not be a state filename', async () => {
    const res = await buildRestRoutes(lw, mkCfg()).request('/api/student', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '../evil' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/voice — the teaching-style preference', () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  const lw = { listSlugs: async () => [], call: async () => ({}) } as any;
  let dir: string; let cfgFile: string; let prevEnv: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lwh-voice-'));
    cfgFile = join(dir, 'harness.config.json');
    writeFileSync(cfgFile, JSON.stringify({ student: 'kid' }));
    prevEnv = process.env.HARNESS_CONFIG;
    process.env.HARNESS_CONFIG = cfgFile;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.HARNESS_CONFIG;
    else process.env.HARNESS_CONFIG = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('sets in place, persists, and an empty string clears', async () => {
    const cfg = { student: 'kid', vault: dir } as unknown as HarnessConfig;
    const app = buildRestRoutes(lw, cfg);
    await app.request('/api/voice', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice: 'high school, no jargon' }) });
    expect((cfg as any).voice).toBe('high school, no jargon');
    expect(JSON.parse(readFileSync(cfgFile, 'utf8')).voice).toBe('high school, no jargon');
    await app.request('/api/voice', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice: '' }) });
    expect((cfg as any).voice).toBeUndefined();
    expect('voice' in JSON.parse(readFileSync(cfgFile, 'utf8'))).toBe(false);
  });
});

// The Library's resume button read "resume at nn-forward-pass" — a raw slug in learner-facing
// copy (fresh-eyes audit). The route resolves each row's next page to its title; a page that
// cannot be read degrades to null so the client falls back to the slug instead of losing the
// button.
describe('GET /api/paths — nextTitle resolution', () => {
  it('resolves nextSlug to the page title, null when unreadable', async () => {
    const lw = {
      call: async (name: string, args: any) => {
        if (name === 'list_paths') return [
          { slug: 'bp', title: 'Backprop', pages: ['fwd', 'loss'] },
          { slug: 'ghost', title: 'Ghost', pages: ['missing'] },
        ];
        if (name === 'get_student_state') return {};
        if (name === 'read_page') {
          if (args.slug === 'fwd') return { page: { meta: { title: 'Forward pass' } } };
          throw new Error('no such page');
        }
        throw new Error(`unexpected ${name}`);
      },
    } as any;
    const app = buildRestRoutes(lw, { student: 'kid' } as HarnessConfig);
    const body = await (await app.request('/api/paths')).json();
    expect(body.paths[0].nextSlug).toBe('fwd');
    expect(body.paths[0].nextTitle).toBe('Forward pass');
    expect(body.paths[1].nextTitle).toBeNull();
  });
});
