import { describe, it, expect } from 'vitest';
import { budgetChars, classifyFailure, isTransportFailure } from '../src/server/pipeline.js';
import { LlmHttpError } from '../src/server/llm/index.js';

describe('budgetChars', () => {
  it('derives a char budget from contextTokens with scaffold headroom', () => {
    // tokens*4 chars minus 8k scaffold reserve (system + schema + instructions)
    expect(budgetChars(32_768)).toBe(32_768 * 4 - 8_000);
  });
  it('falls back to the proven CHAPTER_CHUNK_CHARS default when unset', () => {
    expect(budgetChars(undefined)).toBe(24_000);
  });
  it('never returns less than 4k chars even for a tiny window', () => {
    expect(budgetChars(1_000)).toBe(4_000);
  });
});

describe('classifyFailure', () => {
  it('transport: LlmHttpError and undici fetch-failed', () => {
    expect(classifyFailure(new LlmHttpError('ollama', 503, 'boom'), 10, 100)).toBe('transport');
    expect(classifyFailure(new TypeError('fetch failed'), 10, 100)).toBe('transport');
  });
  it('overflow: the prompt did not fit the budget', () => {
    expect(classifyFailure(new Error('schema rejected'), 200, 100)).toBe('overflow');
  });
  it('weak-output: it fit, the model still failed', () => {
    expect(classifyFailure(new Error('schema rejected'), 50, 100)).toBe('weak-output');
  });
});

import { mapPieces } from '../src/server/pipeline.js';

describe('mapPieces', () => {
  it('runs pieces concurrently up to the cap, results in piece order', async () => {
    let live = 0; let peak = 0;
    const { results, receipts } = await mapPieces({
      pieces: ['a', 'b', 'c', 'd', 'e'],
      budget: 100,
      concurrency: 2,
      attempt: async (p) => {
        live++; peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 10));
        live--;
        return p.toUpperCase();
      },
      floor: async () => 'FLOOR',
    });
    expect(results).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(peak).toBeLessThanOrEqual(2);
    expect(receipts.every((r) => r.outcome === 'ok')).toBe(true);
  });

  it('retries once with the rejection message, then floors with a diagnosed class', async () => {
    const attempts: (string | undefined)[] = [];
    const { results, receipts } = await mapPieces({
      pieces: ['x'.repeat(10)],
      budget: 100,
      attempt: async (_p, rejection) => { attempts.push(rejection); throw new Error('schema rejected'); },
      floor: async (_p, cls, reason) => `floored:${cls}:${reason}`,
    });
    expect(attempts).toEqual([undefined, 'schema rejected']); // retry carried the why
    expect(results[0]).toBe('floored:weak-output:schema rejected');
    expect(receipts[0]).toMatchObject({ outcome: 'floored', class: 'weak-output' });
  });

  it('an oversize piece floors as overflow', async () => {
    const { receipts } = await mapPieces({
      pieces: ['y'.repeat(500)],
      budget: 100,
      attempt: async () => { throw new Error('cut off'); },
      floor: async () => 'floored',
    });
    expect(receipts[0].class).toBe('overflow');
  });

  it('transport failure rejects the whole map — queues must retry later, not consume', async () => {
    await expect(mapPieces({
      pieces: ['a'],
      budget: 100,
      attempt: async () => { throw new TypeError('fetch failed'); },
      floor: async () => 'never',
    })).rejects.toThrow(/fetch failed/);
  });
});
