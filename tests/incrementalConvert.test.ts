import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startConversion, readQueue } from '../src/server/ingest.js';
import type { IncrementalConverter } from '../src/server/convert.js';
import type { HarnessConfig } from '../src/server/config.js';

/** startConversion needs a Loreweaver for its post-completion ensureCompileDrain kick — these
 * tests use cfg.models = {} (no compile role), so ensureCompileDrain's own defensive guard bails
 * out immediately without touching lw at all. A minimal stub is enough. */
function fakeLw() {
  return {} as any;
}

function cfgFor(vault: string): HarnessConfig {
  return { vault, student: 'kid', models: {} } as unknown as HarnessConfig;
}

/** Poll until fn() is truthy. */
async function until<T>(fn: () => T, ms = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('until(): timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('startConversion — progressive chapter queueing (book mode)', () => {
  it('queues completed chapters as they are confirmed by later updates, holds the growing last one, and queues the rest on final', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-incr-'));

    let releaseGate: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });

    const update1 = {
      markdown: '# Chapter One\nPartial content for chapter one, still being written.',
      pagesDone: 10, pagesTotal: 30, final: false,
    };
    const update2 = {
      // Chapter One is now confirmed complete (a later H1 exists); Chapter Two is the new,
      // still-growing last section.
      markdown: [
        '# Chapter One',
        'Full content for chapter one, now complete.',
        '# Chapter Two',
        'Partial content for chapter two.',
      ].join('\n'),
      pagesDone: 20, pagesTotal: 30, final: false,
    };
    const update3Final = {
      markdown: [
        '# Chapter One',
        'Full content for chapter one, now complete.',
        '# Chapter Two',
        'Full content for chapter two, now complete.',
        '# Chapter Three',
        'Content for chapter three, the last one.',
      ].join('\n'),
      pagesDone: 30, pagesTotal: 30, final: true,
    };

    const fakeIncremental: IncrementalConverter = async (_file, _outDir, onProgress) => {
      await onProgress(update1);
      await onProgress(update2);
      await gate; // pause here so the test can inspect mid-flight ledger state
      await onProgress(update3Final);
    };

    startConversion(fakeLw(), cfgFor(vault), '/uploads/Big Scanned Book.pdf', {
      incrementalConverter: fakeIncremental,
      mode: 'book',
    });

    // After update1: only a growing single section — nothing "complete" yet, nothing queued.
    // After update2: Chapter One is confirmed complete and queued as 'pending'; Chapter Two is
    // still the (unqueued) growing last section. Poll for that pending entry to appear.
    await until(() => readQueue(vault).some((e) => e.status === 'pending'));

    let ledger = readQueue(vault);
    const pendingAfter2 = ledger.filter((e) => e.status === 'pending');
    expect(pendingAfter2).toHaveLength(1);
    expect(pendingAfter2[0].title).toBe('Chapter One');

    const placeholder = ledger.find((e) => e.status === 'converting');
    expect(placeholder).toBeTruthy();
    expect(placeholder!.progress).toEqual({ pagesDone: 20, pagesTotal: 30 });

    // Chapter One's file is already on disk, mid-flight.
    const bookDir = join(vault, 'raw', 'uploads', 'big-scanned-book');
    expect(existsSync(join(bookDir, 'ch-01-chapter-one.md'))).toBe(true);
    expect(existsSync(join(bookDir, 'ch-02-chapter-two.md'))).toBe(false);

    // Now let the final update land.
    releaseGate!();
    await until(() => !readQueue(vault).some((e) => e.status === 'converting'));

    ledger = readQueue(vault);
    expect(ledger.filter((e) => e.status === 'converting')).toHaveLength(0);
    const pendingFinal = ledger.filter((e) => e.status === 'pending');
    expect(pendingFinal).toHaveLength(3);
    expect(pendingFinal.map((e) => e.title)).toEqual(['Chapter One', 'Chapter Two', 'Chapter Three']);

    // Each chapter queued exactly once — no duplicates from re-processing earlier updates.
    const chapterPaths = pendingFinal.map((e) => e.chapter);
    expect(new Set(chapterPaths).size).toBe(3);

    for (const p of chapterPaths) expect(existsSync(join(vault, p))).toBe(true);
    const ch2 = readFileSync(join(bookDir, 'ch-02-chapter-two.md'), 'utf8');
    expect(ch2).toContain('Full content for chapter two, now complete.');
  });
});

describe('startConversion — single-shot Converter still works (backward compat)', () => {
  it('wraps a plain Converter into one final progress update and queues all chapters at once', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-incr-single-'));
    const md = '# Only Chapter\nAll content arrives in one shot.';

    startConversion(fakeLw(), cfgFor(vault), '/uploads/Small Book.pdf', {
      converter: async () => ({ markdown: md }),
      mode: 'book',
    });

    await until(() => readQueue(vault).some((e) => e.status === 'pending'));
    const ledger = readQueue(vault);
    expect(ledger.filter((e) => e.status === 'converting')).toHaveLength(0);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ title: 'Only Chapter', status: 'pending' });
  });
});
