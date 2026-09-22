import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnkiClient } from '../src/server/anki/client.js';
import { syncInbound, recentLapses } from '../src/server/anki/inbound.js';
import { Engram } from '../src/server/mcp.js';
import type { HarnessConfig } from '../src/server/config.js';
import { LW_REPO } from './lwRepo.js';


// Scripted AnkiConnect fixture: `reviews` is mutated between phases of the test to simulate
// new cardReviews arriving over time. cardsInfo resolves cardID -> noteId per NOTE_OF_CARD.
let reviews: number[][] = [];
const NOTE_OF_CARD: Record<number, number> = { 55: 2001, 66: 3001 };

let server: ReturnType<typeof serve>;
let url: string;

beforeAll(async () => {
  const app = new Hono();
  app.post('/', async (c) => {
    const body = await c.req.json();
    const { action, params } = body as { action: string; params: any };
    if (action === 'version') return c.json({ result: 6, error: null });
    if (action === 'cardReviews') {
      const startID: number = params.startID ?? 0;
      const out = reviews.filter((r) => r[0] > startID);
      return c.json({ result: out, error: null });
    }
    if (action === 'cardsInfo') {
      const cards: number[] = params.cards ?? [];
      const out = cards.map((id) => ({ cardId: id, note: NOTE_OF_CARD[id] }));
      return c.json({ result: out, error: null });
    }
    return c.json({ result: null, error: null });
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => { url = `http://127.0.0.1:${info.port}`; resolve(); });
  });
});
afterAll(() => server.close());

async function makeVaultEngram(student: string, slugs: string[]) {
  const vault = mkdtempSync(join(tmpdir(), 'lwh-vault-'));
  mkdirSync(join(vault, 'pages'), { recursive: true });
  for (const slug of slugs) {
    writeFileSync(join(vault, 'pages', `${slug}.md`),
      `---\ntitle: ${slug}\ndifficulty: 1\nstatus: solid\n---\nsome content about ${slug}`);
  }
  const cfg = {
    vault, student,
    engram: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
  } as HarnessConfig;
  const lw = await Engram.connect(cfg);
  return { vault, cfg, lw };
}

function writeLedger(vault: string, entries: Record<string, { slug: string; hash: string }>) {
  mkdirSync(join(vault, '.harness'), { recursive: true });
  writeFileSync(join(vault, '.harness', 'anki-map.json'), JSON.stringify(entries));
}

describe('syncInbound', () => {
  it('never-promote ceiling, lapse surfacing, cursor advance, offline handling', async () => {
    reviews = [];
    const { vault, cfg, lw } = await makeVaultEngram('kid1', ['derivatives', 'chain-rule']);
    writeLedger(vault, {
      2001: { slug: 'derivatives', hash: 'h1' },
      3001: { slug: 'chain-rule', hash: 'h2' },
    });
    // Seed derivatives to 'practicing' via two real record_evidence calls.
    await lw.call('record_evidence', { student: 'kid1', slug: 'derivatives', kind: 'explained-correctly', note: 'seed 1' });
    await lw.call('record_evidence', { student: 'kid1', slug: 'derivatives', kind: 'applied-correctly', note: 'seed 2' });
    const before = await lw.call('get_student_state', { student: 'kid1', slug: 'derivatives' });
    expect(before.detail.level).toBe('practicing');

    const anki = new AnkiClient(url);

    // Phase 1: a single ease-4 (Easy) review for derivatives (card 55 -> note 2001).
    reviews.push([Date.now() - 3_600_000, 55, -1, 4, 10, 5, 2500, 4000, 1]); // 1h ago — stays inside recentLapses windows forever
    const first = await syncInbound(lw, anki, cfg);
    expect(first.recorded).toBe(1);

    const after = await lw.call('get_student_state', { student: 'kid1', slug: 'derivatives' });
    // Ceiling: success evidence from Anki never promotes past the current level. (It does not
    // maintain either — see 'an anki success does not refresh the decay clock' below.)
    expect(after.detail.level).toBe('practicing');
    expect(after.detail.evidence.at(-1).kind).toBe('exposed');

    // Phase 2: an ease-1 (Again) review for chain-rule (card 66 -> note 3001), later timestamp.
    reviews.push([Date.now() - 3_000_000, 66, -1, 1, 10, 5, 2500, 4000, 1]); // 50min ago
    const second = await syncInbound(lw, anki, cfg);
    expect(second.recorded).toBe(1);

    const chainRule = await lw.call('get_student_state', { student: 'kid1', slug: 'chain-rule' });
    expect(chainRule.detail.evidence.at(-1).kind).toBe('struggled');

    const lapsePath = join(vault, '.harness', 'anki-lapses.jsonl');
    expect(existsSync(lapsePath)).toBe(true);
    expect(readFileSync(lapsePath, 'utf8')).toMatch(/"slug":"chain-rule"/);
    expect(recentLapses(vault)).toEqual([{ slug: 'chain-rule', count: 1 }]);

    // Phase 3: no new reviews since cursor advanced — records nothing.
    const third = await syncInbound(lw, anki, cfg);
    expect(third.recorded).toBe(0);

    await lw.close();
  }, 30_000);

  it('a deleted page in the ledger does not abort the sync — its reviews are skipped, live ones record', async () => {
    reviews = [];
    // Only 'derivatives' has a page; 'ghost' is in the ledger (its Anki card outlived the page).
    const { vault, cfg, lw } = await makeVaultEngram('kid2', ['derivatives']);
    writeLedger(vault, {
      2001: { slug: 'derivatives', hash: 'h1' }, // card 55
      3001: { slug: 'ghost', hash: 'h2' },        // card 66 — page was deleted
    });
    const anki = new AnkiClient(url);
    // Reviews for BOTH cards. Before the fix, read_page('ghost') threw and the whole sync aborted.
    reviews.push([Date.now() - 3_600_000, 55, -1, 4, 10, 5, 2500, 4000, 1]); // derivatives, Easy
    reviews.push([Date.now() - 3_000_000, 66, -1, 4, 10, 5, 2500, 4000, 1]); // ghost, Easy

    const res = await syncInbound(lw, anki, cfg); // must not throw
    expect(res.recorded).toBe(1); // only the live slug

    const dv = await lw.call('get_student_state', { student: 'kid2', slug: 'derivatives' });
    expect(dv.detail.evidence.at(-1).kind).toBe('exposed');
    // The cursor advanced past BOTH reviews, so the ghost review is not re-examined next run.
    const again = await syncInbound(lw, anki, cfg);
    expect(again.recorded).toBe(0);
    await lw.close();
  }, 30_000);

  it('returns {recorded: 0} cleanly when Anki is unreachable', async () => {
    let downPort = 0;
    await new Promise<void>((resolve) => {
      const tmp = serve({ fetch: new Hono().fetch, port: 0 }, (info) => {
        downPort = info.port;
        tmp.close(() => resolve());
      });
    });
    const anki = new AnkiClient(`http://127.0.0.1:${downPort}`);
    const fakeLw = { call: async () => { throw new Error('lw.call should not be invoked when Anki is down'); } };
    const result = await syncInbound(fakeLw as unknown as Engram, anki,
      { vault: mkdtempSync(join(tmpdir(), 'lwh-vault-')), student: 'x' } as HarnessConfig);
    expect(result).toEqual({ recorded: 0 });
  });
});

/**
 * Lapses arrive in the order Anki happened to review them. The tutor reads the injected line
 * top-down, so a page lapsed twice could lead one lapsed four times and the milder problem gets
 * picked up first — seen live, with a 2-lapse page chosen over a 4-lapse one.
 */
describe('lapses are ordered worst-first', () => {
  it('sorts by count, then by slug for a stable tie', () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-lapse-order-'));
    mkdirSync(join(vault, '.harness'), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const rows = [
      ...Array(2).fill({ date: today, slug: 'mild' }),
      ...Array(4).fill({ date: today, slug: 'worst' }),
      ...Array(2).fill({ date: today, slug: 'also-mild' }),
    ];
    writeFileSync(join(vault, '.harness', 'anki-lapses.jsonl'),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(recentLapses(vault).map((l) => l.slug)).toEqual(['worst', 'also-mild', 'mild']);
  });
});

/**
 * recentLapses runs in session bootstrap — the first turn of every thread. A crash mid-append (or a
 * disk-full) leaves a half-written line in the jsonl, and the unguarded JSON.parse threw straight
 * out of bootstrap and 500d that turn, every turn, until someone hand-edited a file that is pure
 * telemetry.
 */
describe('a torn lapse line costs its own count, not the turn', () => {
  it('skips what it cannot parse, still counts the rest, and says so once', () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-lapse-torn-'));
    mkdirSync(join(vault, '.harness'), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(vault, '.harness', 'anki-lapses.jsonl'), [
      JSON.stringify({ date: today, slug: 'intact' }),
      `{"date":"${today}","slu`, // append interrupted: the tail never reached disk
      JSON.stringify({ date: today, slug: 'intact' }),
      'null', // parses fine, destructures to a TypeError — the same 500 by another route
    ].join('\n') + '\n');

    const errs: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a); });
    try {
      expect(recentLapses(vault)).toEqual([{ slug: 'intact', count: 2 }]);
    } finally {
      spy.mockRestore();
    }
    // Loud, not silent: a file quietly rotting line by line reads as "no recent lapses" otherwise.
    // One row per read, not per bad line — this runs on every bootstrap.
    expect(errs).toHaveLength(1);
    expect(String(errs[0][0])).toMatch(/skipped 2 unparseable/);
  });
});

/**
 * The ceiling's other half was documented as true and is not: inbound's comment and README line 4
 * both claimed an Anki review "refreshes the decay clock". engram counts an 'exposed' that raises
 * no level as an ENCOUNTER rather than a confirmation (model.ts's `reconfirmsStanding`), and so
 * keeps the existing clock — for exactly practicing and mastered, the only levels that HAVE one.
 * This pins what the code actually does, so if the mastery model ever grows a real maintain, this
 * is where you find out the docs have to change with it.
 */
describe('an anki success does not refresh the decay clock', () => {
  it('leaves last_reinforced on a practicing page exactly where it was', async () => {
    reviews = [];
    const { vault, cfg, lw } = await makeVaultEngram('kid4', ['derivatives']);
    writeLedger(vault, { 2001: { slug: 'derivatives', hash: 'h1' } }); // card 55 -> note 2001

    // Seeded on disk rather than through record_evidence: every call in this suite lands on today,
    // and a clock that never moved is indistinguishable from one reset to today unless the page
    // starts stale. 20 days in, one day short of the 21-day practicing window.
    const stale = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
    mkdirSync(join(vault, 'students'), { recursive: true });
    writeFileSync(join(vault, 'students', 'kid4.json'), JSON.stringify({
      derivatives: {
        level: 'practicing',
        evidence: [{ date: stale, kind: 'explained-correctly', note: 'seed' }],
        misconceptions: [],
        last_reinforced: stale,
      },
    }));

    const anki = new AnkiClient(url);
    reviews.push([Date.now() - 3_600_000, 55, -1, 4, 10, 5, 2500, 4000, 1]); // Easy, 1h ago
    expect((await syncInbound(lw, anki, cfg)).recorded).toBe(1);

    const after = await lw.call('get_student_state', { student: 'kid4', slug: 'derivatives' });
    expect(after.detail.evidence.at(-1).kind).toBe('exposed');
    expect(after.detail.level).toBe('practicing'); // never promotes — that half is real
    expect(after.detail.last_reinforced).toBe(stale); // the review bought no days
    expect(after.detail.days_left).toBe(1); // still one day from slipping, as before the review
    await lw.close();
  }, 30_000);
});
