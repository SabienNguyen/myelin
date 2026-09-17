// The shared Anki ledger mutex (anki/ledger.ts) and the guarded read it gives both inbound.ts and
// outbound.ts. Exercised directly here — fast and deterministic — plus one test that runs
// syncInbound and syncOutbound concurrently against fake Anki/Engram clients to prove the shared
// module actually keeps them from clobbering each other on the real file.
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAnkiLedger, withAnkiLedger } from '../src/server/anki/ledger.js';
import { syncInbound } from '../src/server/anki/inbound.js';
import { syncOutbound } from '../src/server/anki/outbound.js';
import type { AnkiClient } from '../src/server/anki/client.js';
import type { Engram } from '../src/server/mcp.js';
import type { HarnessConfig } from '../src/server/config.js';

function mkVault(): string {
  const vault = mkdtempSync(join(tmpdir(), 'lwh-anki-ledger-'));
  mkdirSync(join(vault, '.harness'), { recursive: true });
  return vault;
}

function ledgerPath(vault: string): string {
  return join(vault, '.harness', 'anki-map.json');
}

describe('readAnkiLedger', () => {
  it('a corrupt ledger logs and reads as empty, never throws', () => {
    const vault = mkVault();
    writeFileSync(ledgerPath(vault), '{not valid json');
    const errors: unknown[] = [];
    const spy = (...args: unknown[]) => errors.push(args);
    const original = console.error;
    console.error = spy;
    try {
      expect(readAnkiLedger(vault)).toEqual({});
    } finally {
      console.error = original;
    }
    expect(errors.length).toBe(1);
  });

  it('a missing ledger reads as empty with no error logged', () => {
    const vault = mkVault();
    expect(readAnkiLedger(vault)).toEqual({});
  });
});

describe('withAnkiLedger', () => {
  it('serializes overlapping mutations onto one vault — neither call\'s write is lost', async () => {
    const vault = mkVault();
    const [a, b] = await Promise.all([
      withAnkiLedger(vault, async (ledger) => { ledger['111'] = { slug: 'a', hash: 'ha' }; return 'a-done'; }),
      withAnkiLedger(vault, async (ledger) => { ledger['222'] = { slug: 'b', hash: 'hb' }; return 'b-done'; }),
    ]);
    expect([a, b].sort()).toEqual(['a-done', 'b-done']);
    const ledger = readAnkiLedger(vault);
    expect(ledger['111']).toEqual({ slug: 'a', hash: 'ha' });
    expect(ledger['222']).toEqual({ slug: 'b', hash: 'hb' });
  });

  it('a throwing mutator does not wedge a later caller against the same vault', async () => {
    const vault = mkVault();
    await expect(withAnkiLedger(vault, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const result = await withAnkiLedger(vault, async (ledger) => { ledger['1'] = { slug: 'x', hash: 'h' }; return 'ok'; });
    expect(result).toBe('ok');
    expect(readAnkiLedger(vault)['1']).toEqual({ slug: 'x', hash: 'h' });
  });
});

describe('overlapping inbound and outbound sync', () => {
  it('do not lose each other\'s ledger writes', async () => {
    const vault = mkVault();
    // Pre-seed one already-synced note so inbound has something to pull reviews for.
    writeFileSync(ledgerPath(vault), JSON.stringify({ 2001: { slug: 'derivatives', hash: 'seed' } }));
    const cfg = { vault, student: 'kid' } as HarnessConfig;

    const fakeAnki = {
      isUp: async () => true,
      invoke: async (action: string, params: any) => {
        if (action === 'cardReviews') return [[Date.now(), 55, -1, 4, 10, 5, 2500, 4000, 1]];
        if (action === 'cardsInfo') return (params.cards as number[]).map((id) => ({ cardId: id, note: 2001 }));
        if (action === 'createDeck') return 1;
        if (action === 'addNote') return 9001;
        return null;
      },
    } as unknown as AnkiClient;

    const fakeLw = {
      call: async (tool: string, args: any) => {
        if (tool === 'read_page') return { page: { domain: 'math', body: 'content' } };
        if (tool === 'record_evidence') return { ok: true };
        if (tool === 'get_student_state') return { fresh: { effective: 'mastered', misconceptions: [] } };
        throw new Error(`unexpected tool ${tool}`);
      },
    } as unknown as Engram;

    const [inboundResult, outboundResult] = await Promise.all([
      syncInbound(fakeLw, fakeAnki, cfg),
      syncOutbound(fakeLw, fakeAnki, cfg, {
        generateCards: async () => [{ front: 'Q', back: 'A' }],
      }),
    ]);

    expect(inboundResult.recorded).toBe(1);
    expect(outboundResult.pushed).toBe(1);

    const ledger = readAnkiLedger(vault);
    // Inbound's cursor advance and outbound's newly-pushed note both landed in the same file.
    expect(ledger._cursor).toBeGreaterThan(0);
    expect(ledger['2001']).toEqual({ slug: 'derivatives', hash: 'seed' });
    expect(ledger['9001']).toEqual({ slug: 'fresh', hash: expect.any(String) });
  });
});

