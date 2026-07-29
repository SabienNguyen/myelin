import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  it('maintain-never-promote ceiling, lapse surfacing, cursor advance, offline handling', async () => {
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
    // Ceiling: success evidence from Anki maintains — never promotes past current level.
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
