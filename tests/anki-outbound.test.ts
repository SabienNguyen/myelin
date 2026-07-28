import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnkiClient } from '../src/server/anki/client.js';
import { syncOutbound } from '../src/server/anki/outbound.js';
import { Loreweaver } from '../src/server/mcp.js';
import type { HarnessConfig } from '../src/server/config.js';
import { LW_REPO } from './lwRepo.js';


const received: any[] = [];
let server: ReturnType<typeof serve>;
let url: string;

beforeAll(async () => {
  const app = new Hono();
  let nextId = 1000;
  app.post('/', async (c) => {
    const body = await c.req.json();
    received.push(body);
    // NOTE: addNote's id is only assigned for actual addNote calls — an id computed
    // unconditionally in this object literal would advance on every request (including
    // isUp()'s 'version' probe), which breaks deterministic id assertions below.
    const results: Record<string, unknown> = {
      version: 6, createDeck: 1, findNotes: [], notesInfo: [], updateNoteFields: null,
    };
    if (body.action === 'addNote') results.addNote = nextId++;
    return c.json({ result: results[body.action] ?? null, error: null });
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => { url = `http://127.0.0.1:${info.port}`; resolve(); });
  });
});
afterAll(() => server.close());

describe('AnkiClient', () => {
  it('speaks the version-6 envelope', async () => {
    const anki = new AnkiClient(url);
    expect(await anki.isUp()).toBe(true);
    const id = await anki.invoke('addNote', { note: { deckName: 'D', modelName: 'Basic',
      fields: { Front: 'q', Back: 'a' }, options: { allowDuplicate: false, duplicateScope: 'deck' },
      tags: ['loreweaver::chain-rule'] } });
    expect(id).toBe(1000);
    const call = received.find((r) => r.action === 'addNote');
    expect(call.version).toBe(6);
    expect(call.params.note.tags).toEqual(['loreweaver::chain-rule']);
  });
  it('throws readable errors', async () => {
    const app = new Hono();
    app.post('/', (c) => c.json({ result: null, error: 'collection is not available' }));
    const s = serve({ fetch: app.fetch, port: 0 }, async (info) => {
      const bad = new AnkiClient(`http://127.0.0.1:${info.port}`);
      await expect(bad.invoke('addNote', {})).rejects.toThrow(/collection/);
      s.close();
    });
  });
});

async function makeVaultLoreweaver(student: string, slug: string, title: string) {
  const vault = mkdtempSync(join(tmpdir(), 'lwh-vault-'));
  mkdirSync(join(vault, 'pages'), { recursive: true });
  writeFileSync(join(vault, 'pages', `${slug}.md`),
    `---\ntitle: ${title}\ndifficulty: 1\nstatus: solid\n---\nsome content about ${title}`);
  const cfg = {
    vault, student,
    loreweaver: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
  } as HarnessConfig;
  const lw = await Loreweaver.connect(cfg);
  return { vault, cfg, lw };
}

async function bringToPracticing(lw: Loreweaver, student: string, slug: string) {
  await lw.call('record_evidence', { student, slug, kind: 'explained-correctly', note: 'seed 1' });
  await lw.call('record_evidence', { student, slug, kind: 'applied-correctly', note: 'seed 2' });
}

describe('syncOutbound — ledger dedup and update-in-place', () => {
  it('pushes new cards then skips unchanged cards on a second run', async () => {
    const { vault, cfg, lw } = await makeVaultLoreweaver('kid1', 'derivatives', 'Derivatives');
    await bringToPracticing(lw, 'kid1', 'derivatives');
    const anki = new AnkiClient(url);
    const generateCards = async () => [{ front: 'Q1', back: 'A1' }, { front: 'Q2', back: 'A2' }];

    const first = await syncOutbound(lw, anki, cfg, { generateCards });
    expect(first).toEqual({ pushed: 2, updated: 0, skipped: 0, failed: 0 });

    const second = await syncOutbound(lw, anki, cfg, { generateCards });
    expect(second).toEqual({ pushed: 0, updated: 0, skipped: 2, failed: 0 });

    const ledgerPath = join(vault, '.harness', 'anki-map.json');
    expect(existsSync(ledgerPath)).toBe(true);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    expect(Object.values(ledger).every((v: any) => v.slug === 'derivatives')).toBe(true);
    expect(Object.keys(ledger).length).toBe(2);

    await lw.close();
  }, 30_000);

  it('updates notes in place when generated card content changes', async () => {
    const { cfg, lw } = await makeVaultLoreweaver('kid2', 'chain-rule', 'Chain Rule');
    await bringToPracticing(lw, 'kid2', 'chain-rule');
    const anki = new AnkiClient(url);

    const first = await syncOutbound(lw, anki, cfg, {
      generateCards: async () => [{ front: 'Q1', back: 'A1' }],
    });
    expect(first).toEqual({ pushed: 1, updated: 0, skipped: 0, failed: 0 });

    const second = await syncOutbound(lw, anki, cfg, {
      generateCards: async () => [{ front: 'Q1', back: 'A1 revised' }],
    });
    expect(second).toEqual({ pushed: 0, updated: 1, skipped: 0, failed: 0 });

    await lw.close();
  }, 30_000);

  it('never promotes past 4 cards per page even if more are generated', async () => {
    const { cfg, lw } = await makeVaultLoreweaver('kid3', 'limits', 'Limits');
    await bringToPracticing(lw, 'kid3', 'limits');
    const anki = new AnkiClient(url);
    const generateCards = async () => [
      { front: 'Q1', back: 'A1' }, { front: 'Q2', back: 'A2' },
      { front: 'Q3', back: 'A3' }, { front: 'Q4', back: 'A4' }, { front: 'Q5', back: 'A5' },
    ];
    const result = await syncOutbound(lw, anki, cfg, { generateCards });
    expect(result.pushed).toBe(4);

    await lw.close();
  }, 30_000);

  it('skips pages below practicing effective mastery', async () => {
    const { cfg, lw } = await makeVaultLoreweaver('kid4', 'unseen-page', 'Unseen Page');
    // no evidence recorded — stays 'unseen', never appears in get_student_state map
    const anki = new AnkiClient(url);
    let called = false;
    const result = await syncOutbound(lw, anki, cfg, {
      generateCards: async () => { called = true; return [{ front: 'Q', back: 'A' }]; },
    });
    expect(called).toBe(false);
    expect(result).toEqual({ pushed: 0, updated: 0, skipped: 0, failed: 0 });

    await lw.close();
  }, 30_000);

  it('a slug with evidence but a since-deleted page is skipped, not fatal for the whole run', async () => {
    const { vault, cfg, lw } = await makeVaultLoreweaver('kid6', 'derivatives', 'Derivatives');
    // A second page earns evidence, then its file is deleted — student state persists, so it stays
    // in get_student_state while read_page now throws for it. Before the guard, that aborted the
    // entire run and NO page synced.
    writeFileSync(join(vault, 'pages', 'ghost.md'),
      '---\ntitle: Ghost\ndifficulty: 1\nstatus: solid\n---\nsoon gone');
    await bringToPracticing(lw, 'kid6', 'derivatives');
    await bringToPracticing(lw, 'kid6', 'ghost');
    rmSync(join(vault, 'pages', 'ghost.md')); // snapshot re-reads disk, so read_page('ghost') now errs
    const anki = new AnkiClient(url);
    const res = await syncOutbound(lw, anki, cfg, { generateCards: async () => [{ front: 'Q', back: 'A' }] });
    expect(res.failed).toBe(0);
    expect(res.pushed).toBe(1); // derivatives synced; ghost skipped without throwing
    await lw.close();
  }, 30_000);
});

describe('syncOutbound — claude-sdk: prefixed card_gen model', () => {
  it('routes llmGenerateCards to the injected fake and parses the FRONT/BACK format', async () => {
    const { cfg, lw } = await makeVaultLoreweaver('kid5', 'integrals', 'Integrals');
    await bringToPracticing(lw, 'kid5', 'integrals');
    const anki = new AnkiClient(url);

    const calls: any[] = [];
    const sdkGenerate = async (opts: any) => {
      calls.push(opts);
      return { text: 'FRONT: Q1\nBACK: A1\n===', toolCallNames: [] };
    };
    const sdkCfg = { ...cfg, models: { card_gen: { model: 'claude-sdk:sonnet' } } } as HarnessConfig;

    const result = await syncOutbound(lw, anki, sdkCfg, { deps: { sdkGenerate } });
    expect(result).toEqual({ pushed: 1, updated: 0, skipped: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('sonnet');
    expect(calls[0].prompt).toContain('Integrals');

    await lw.close();
  }, 30_000);
});

describe('syncOutbound — claude-sdk card_gen wrapped in a markdown fence', () => {
  it('tolerates a whole-response fence around the FRONT/BACK blocks', async () => {
    const { cfg, lw } = await makeVaultLoreweaver('kid7', 'fenced-page', 'Fenced Page');
    await bringToPracticing(lw, 'kid7', 'fenced-page');
    (cfg as any).models = { card_gen: { model: 'claude-sdk:sonnet' } };
    const anki = new AnkiClient(url);
    const result = await syncOutbound(lw, anki, cfg, {
      deps: {
        sdkGenerate: async () => ({
          text: '```\nFRONT: Q\nBACK: A\n===\n```',
        }) as any,
      },
    });
    expect(result).toEqual({ pushed: 1, updated: 0, skipped: 0, failed: 0 });
    await lw.close();
  }, 30_000);
});

describe('syncOutbound — Anki offline', () => {
  it('skips silently without touching Loreweaver when Anki is down', async () => {
    // Bind then immediately close a server to get a port nothing is listening on.
    let downPort = 0;
    await new Promise<void>((resolve) => {
      const tmp = serve({ fetch: new Hono().fetch, port: 0 }, (info) => {
        downPort = info.port;
        tmp.close(() => resolve());
      });
    });
    const anki = new AnkiClient(`http://127.0.0.1:${downPort}`);
    const fakeLw = { call: async () => { throw new Error('lw.call should not be invoked when Anki is down'); } };
    const result = await syncOutbound(fakeLw as unknown as Loreweaver, anki,
      { vault: mkdtempSync(join(tmpdir(), 'lwh-vault-')), student: 'x' } as HarnessConfig,
      { generateCards: async () => [{ front: 'x', back: 'y' }] });
    expect(result).toEqual({ pushed: 0, updated: 0, skipped: 0, failed: 0 });
  });
});

// A live probe saw the sdk card_gen emit unparseable JSON for one math-heavy page — and the
// whole sync die with it. One page's bad generation must not abort every other page's cards.
describe('syncOutbound — one page failing generation does not abort the run', () => {
  it('counts the failure and still pushes the other page', async () => {
    const { vault, cfg, lw } = await makeVaultLoreweaver('kid6', 'good-page', 'Good Page');
    writeFileSync(join(vault, 'pages', 'bad-page.md'),
      '---\ntitle: Bad Page\ndifficulty: 1\nstatus: solid\n---\nmath-heavy content');
    await bringToPracticing(lw, 'kid6', 'good-page');
    await bringToPracticing(lw, 'kid6', 'bad-page');
    const anki = new AnkiClient(url);

    const result = await syncOutbound(lw, anki, cfg, {
      generateCards: async (slug) => {
        if (slug === 'bad-page') throw new Error('claude-sdk card_gen returned invalid JSON');
        return [{ front: `q-${slug}`, back: `a-${slug}` }];
      },
    });
    expect(result).toEqual({ pushed: 1, updated: 0, skipped: 0, failed: 1 });

    await lw.close();
  }, 30_000);
});

// The push to Anki can fail for one note the same way generation can fail for one page — most
// often a duplicate front, which addNote's `allowDuplicate: false` turns into a thrown error. That
// one throw must not abort the whole run and strand every page ordered after it.
describe('syncOutbound — one page failing to PUSH does not abort the run', () => {
  it('counts the push failure and still pushes the other page', async () => {
    const { vault, cfg, lw } = await makeVaultLoreweaver('kid7', 'ok-page', 'OK Page');
    writeFileSync(join(vault, 'pages', 'dupe-page.md'),
      '---\ntitle: Dupe Page\ndifficulty: 1\nstatus: solid\n---\ncontent for the dupe page');
    await bringToPracticing(lw, 'kid7', 'ok-page');
    await bringToPracticing(lw, 'kid7', 'dupe-page');

    // A dedicated mock that rejects addNote for the dupe page's card the way AnkiConnect rejects a
    // duplicate, and succeeds for everything else.
    const app = new Hono();
    let nextId = 5000;
    app.post('/', async (c) => {
      const body = await c.req.json();
      if (body.action === 'addNote') {
        return String(body.params?.note?.fields?.Front).includes('DUPE')
          ? c.json({ result: null, error: 'cannot create note because it is a duplicate' })
          : c.json({ result: nextId++, error: null });
      }
      const results: Record<string, unknown> = { version: 6, createDeck: 1, updateNoteFields: null };
      return c.json({ result: results[body.action] ?? null, error: null });
    });
    let dupUrl = '';
    const s = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const srv = serve({ fetch: app.fetch, port: 0 }, (info) => { dupUrl = `http://127.0.0.1:${info.port}`; resolve(srv); });
    });

    const result = await syncOutbound(lw, new AnkiClient(dupUrl), cfg, {
      generateCards: async (slug) => [slug === 'dupe-page'
        ? { front: 'DUPE front', back: 'a' } : { front: `q-${slug}`, back: `a-${slug}` }],
    });
    expect(result).toEqual({ pushed: 1, updated: 0, skipped: 0, failed: 1 });

    s.close();
    await lw.close();
  }, 30_000);
});
