// Ingest -> course bank wiring: a document that extracts as a problem set is BANKED, not
// compiled. The ledger says so, no compile entries are queued, and the problems land verbatim in
// vault/.harness/course-bank.jsonl (courseBank.ts's storage). A document that does NOT extract
// keeps the normal book path — the fallback this feature must never break.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startConversion, readQueue } from '../src/server/ingest.js';
import { readBank } from '../src/server/courseBank.js';
import type { HarnessConfig } from '../src/server/config.js';

function fakeLw() {
  return {} as any;
}

function cfgFor(vault: string): HarnessConfig {
  return { vault, student: 'kid', models: {} } as unknown as HarnessConfig;
}

async function until<T>(fn: () => T, ms = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('until(): timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}

const EXAM_MD = [
  '# Midterm 2',
  '',
  'Problem 1. State the time complexity of binary search on a sorted array of n elements.',
  'Answer: O(log n)',
  '',
  'Problem 2. Define a spanning tree of a connected graph G.',
  '',
  '3. Compute the determinant of the 2x2 matrix [[1, 2], [3, 4]].',
  'Answer: -2',
].join('\n');

describe('startConversion — problem sets go to the course bank, not the compile queue', () => {
  it('banks the problems verbatim, records "N problems banked", and queues NO compile entries', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-bank-'));
    startConversion(fakeLw(), cfgFor(vault), '/uploads/Midterm 2 Past Exam.pdf', {
      converter: async () => ({ markdown: EXAM_MD }),
    });

    const bankRow = await until(() => readQueue(vault).find((e) => e.title === '3 problems banked'));
    expect(bankRow?.status).toBe('done');
    expect(bankRow?.book).toBe('Midterm 2 Past Exam');

    const ledger = readQueue(vault);
    expect(ledger.filter((e) => e.status === 'pending')).toHaveLength(0);
    expect(ledger.filter((e) => e.status === 'converting')).toHaveLength(0);

    const bank = readBank(vault);
    expect(bank.map((p) => p.id)).toEqual([
      'midterm-2-past-exam#1', 'midterm-2-past-exam#2', 'midterm-2-past-exam#3',
    ]);
    // The alignment contract: the professor's wording, character for character.
    expect(bank[0].text).toBe('State the time complexity of binary search on a sorted array of n elements.');
    expect(bank[0].answer).toBe('O(log n)');
    expect(bank[1].answer).toBeUndefined();
  });

  it('re-ingesting the same document replaces its bank row instead of duplicating it', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-bank-'));
    const opts = { converter: async () => ({ markdown: EXAM_MD }) };
    startConversion(fakeLw(), cfgFor(vault), '/uploads/pset.md', opts);
    await until(() => readQueue(vault).some((e) => e.title === '3 problems banked'));
    startConversion(fakeLw(), cfgFor(vault), '/uploads/pset.md', opts);
    await until(() => !readQueue(vault).some((e) => e.status === 'converting'));

    expect(readQueue(vault).filter((e) => e.title === '3 problems banked')).toHaveLength(1);
    expect(readBank(vault)).toHaveLength(3);
  });

  it('paper mode banks too — an exam fetched by URL must not become prose pages either', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-bank-'));
    startConversion(fakeLw(), cfgFor(vault), '/uploads/final-2019.pdf', {
      converter: async () => ({ markdown: EXAM_MD }), mode: 'paper',
    });
    await until(() => readQueue(vault).some((e) => e.title === '3 problems banked'));
    expect(readQueue(vault).filter((e) => e.status === 'pending')).toHaveLength(0);
    expect(readBank(vault)).toHaveLength(3);
  });

  it('a document with fewer than three numbered problems keeps the normal book path', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-bank-'));
    startConversion(fakeLw(), cfgFor(vault), '/uploads/Real Book.pdf', {
      converter: async () => ({
        markdown: '# Chapter One\nProse about graphs.\n\n1. One stray numbered line.\n\n# Chapter Two\nMore prose.',
      }),
    });
    await until(() => readQueue(vault).some((e) => e.status === 'pending'));
    const ledger = readQueue(vault);
    expect(ledger.filter((e) => e.status === 'pending')).toHaveLength(2);
    expect(ledger.some((e) => /problems banked/.test(e.title))).toBe(false);
    expect(readBank(vault)).toHaveLength(0);
  });
});
