import { describe, it, expect, vi, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordUsage, readUsage } from '../src/server/usageLedger.js';

const freshVault = () => mkdtempSync(join(tmpdir(), 'lwh-usage-'));
const usage = (inTok: number, out: number, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: inTok, outputTokens: out, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
});

afterEach(() => { vi.restoreAllMocks(); });

describe('recordUsage', () => {
  it('appends one JSONL row per call under .harness/usage.jsonl', () => {
    const vault = freshVault();
    recordUsage(vault, { role: 'tutor', model: 'claude-sonnet-5', usage: usage(100, 20, 400, 50) });
    recordUsage(vault, { role: 'grader', model: 'claude-haiku-4-5', usage: usage(30, 5) });
    const lines = readFileSync(join(vault, '.harness', 'usage.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const row = JSON.parse(lines[0]);
    expect(row).toMatchObject({
      role: 'tutor', model: 'claude-sonnet-5', in: 100, out: 20, cacheRead: 400, cacheWrite: 50,
    });
    expect(Number.isFinite(Date.parse(row.ts))).toBe(true);
  });

  it('still writes an all-zero row — a call that happened is data, whatever it cost', () => {
    const vault = freshVault();
    recordUsage(vault, { role: 'compile', model: 'test', usage: usage(0, 0) });
    const summary = readUsage(vault);
    expect(summary.today.compile).toMatchObject({ in: 0, out: 0, calls: 1 });
  });

  it('swallows a write failure — the ledger must never break the turn it measures', () => {
    const vault = freshVault();
    // Make .harness un-creatable: a regular FILE where the directory should go.
    writeFileSync(join(vault, '.harness'), 'not a directory');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      recordUsage(vault, { role: 'tutor', model: 'x', usage: usage(1, 1) }),
    ).not.toThrow();
    expect(err).toHaveBeenCalled();
  });
});

describe('readUsage', () => {
  // Rows written straight to the file so their timestamps can be back-dated — recordUsage always
  // stamps now. `now` is injected into readUsage; day windows are pinned against it.
  const writeRow = (vault: string, ts: string, role: string, inTok: number, out: number, cacheRead = 0) => {
    mkdirSync(join(vault, '.harness'), { recursive: true });
    appendFileSync(join(vault, '.harness', 'usage.jsonl'),
      `${JSON.stringify({ ts, role, model: 'm', in: inTok, out, cacheRead, cacheWrite: 0 })}\n`);
  };

  it('sums per role for today and the trailing window, and reports the cache-hit share', () => {
    const vault = freshVault();
    const now = () => new Date('2026-07-30T18:00:00Z');
    writeRow(vault, '2026-07-30T09:00:00Z', 'tutor', 100, 10, 300);
    writeRow(vault, '2026-07-30T10:00:00Z', 'tutor', 50, 5, 100);
    writeRow(vault, '2026-07-28T10:00:00Z', 'grader', 40, 4);
    const s = readUsage(vault, { now });
    expect(s.today).toEqual({
      tutor: { in: 150, out: 15, cacheRead: 400, cacheWrite: 0, calls: 2 },
    });
    expect(s.week).toEqual({
      tutor: { in: 150, out: 15, cacheRead: 400, cacheWrite: 0, calls: 2 },
      grader: { in: 40, out: 4, cacheRead: 0, cacheWrite: 0, calls: 1 },
    });
    // 400 cached of (190 fresh + 400 cached) input over the window.
    expect(s.cacheHitShare).toBeCloseTo(400 / 590, 10);
  });

  it('windows by day: a row older than `days` is out of the week, yesterday is out of today', () => {
    const vault = freshVault();
    const now = () => new Date('2026-07-30T02:00:00Z');
    writeRow(vault, '2026-07-29T23:00:00Z', 'tutor', 10, 1); // yesterday: week only
    writeRow(vault, '2026-07-20T12:00:00Z', 'tutor', 999, 99); // beyond 7 days: excluded entirely
    const s = readUsage(vault, { days: 7, now });
    expect(s.today).toEqual({});
    expect(s.week).toEqual({ tutor: { in: 10, out: 1, cacheRead: 0, cacheWrite: 0, calls: 1 } });
  });

  it('skips a corrupt line and keeps summing the rest', () => {
    const vault = freshVault();
    const now = () => new Date('2026-07-30T18:00:00Z');
    writeRow(vault, '2026-07-30T09:00:00Z', 'help', 20, 2);
    appendFileSync(join(vault, '.harness', 'usage.jsonl'), '{"ts": "2026-07-30T09:30:00Z", "role": "hel\n');
    writeRow(vault, '2026-07-30T10:00:00Z', 'help', 5, 1);
    const s = readUsage(vault, { now });
    expect(s.today.help).toEqual({ in: 25, out: 3, cacheRead: 0, cacheWrite: 0, calls: 2 });
  });

  it('empty summary when no ledger exists yet', () => {
    expect(readUsage(freshVault())).toEqual({ today: {}, week: {}, cacheHitShare: null });
  });
});
