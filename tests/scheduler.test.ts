import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDigest, inQuietHours, runDigestTick } from '../src/server/scheduler.js';

const state = {
  derivatives: { level: 'mastered', effective: 'mastered', last_reinforced: '2026-06-01' },   // 41 elapsed → 4 left: no
  'chain-rule': { level: 'mastered', effective: 'mastered', last_reinforced: '2026-06-05' },  // 37 elapsed → 8 left: no
  'loss-functions': { level: 'mastered', effective: 'mastered', last_reinforced: '2026-05-30' }, // 43 → 2 left: soon
  'gradient-descent': { level: 'practicing', effective: 'exposed', last_reinforced: '2026-05-01' }, // decayed
};
const now = new Date('2026-07-12');

describe('computeDigest', () => {
  it('flags decays-soon and decayed, not healthy pages', () => {
    const { items } = computeDigest(state as any, {}, now);
    expect(items.map((i) => `${i.slug}:${i.kind}`).sort()).toEqual([
      'gradient-descent:decayed', 'loss-functions:decays-soon',
    ]);
  });
  it('ledger suppresses repeat notifications for the same event', () => {
    // NOTE: deviation from plan's literal test — the plan advanced `now` by one day here,
    // which causes `derivatives` (daysLeft 4->3) to legitimately cross into its decays-soon
    // window per the explicit rule "0 < daysLeft <= 3" (Task 9 Interfaces). That's a genuinely
    // new event, not a repeat, so the plan's `toEqual([])` assertion was incorrect. Re-running
    // with an unchanged snapshot (same `now`) is what "suppresses repeat notifications for the
    // same event" actually means, and is what this test now checks.
    const first = computeDigest(state as any, {}, now);
    const second = computeDigest(state as any, first.newLedger, now);
    expect(second.items).toEqual([]);
  });
  it('re-notifies after re-reinforcement resets the window', () => {
    const first = computeDigest(state as any, {}, now);
    const bumped = { ...state, 'loss-functions': { ...state['loss-functions'], last_reinforced: '2026-07-12' } };
    // decays again much later
    const later = computeDigest(
      { ...bumped, 'loss-functions': { ...bumped['loss-functions'] } } as any,
      first.newLedger, new Date('2026-08-24')); // 43 days after 2026-07-12 → 2 left again
    expect(later.items.some((i) => i.slug === 'loss-functions')).toBe(true);
  });
});

describe('inQuietHours', () => {
  it('an ordinary daytime window', () => {
    expect(inQuietHours(13, [12, 14])).toBe(true);
    expect(inQuietHours(14, [12, 14])).toBe(false);
    expect(inQuietHours(11, [12, 14])).toBe(false);
  });

  it('a window spanning midnight — [22, 8] quiets 22:00 through 07:59', () => {
    expect(inQuietHours(23, [22, 8])).toBe(true);
    expect(inQuietHours(3, [22, 8])).toBe(true);
    expect(inQuietHours(7, [22, 8])).toBe(true);
    expect(inQuietHours(8, [22, 8])).toBe(false);
    expect(inQuietHours(12, [22, 8])).toBe(false);
    expect(inQuietHours(21, [22, 8])).toBe(false);
  });
});

describe('runDigestTick', () => {
  const decayedDetail = {
    level: 'mastered', effective: 'practicing', last_reinforced: '2026-06-01',
  };
  const makeLw = () => ({
    call: async (_tool: string, args: any) =>
      args.slug ? { detail: decayedDetail } : { 'loss-functions': {} },
  }) as any;
  const cfgFor = (vault: string) => ({
    vault, student: 'kid', schedule: { digestHour: 9, quietHours: [22, 8] as [number, number] },
  }) as any;
  const at = (hour: number) => () => new Date(2026, 6, 27, hour, 30);

  it('quiet hours mean no calls at all — not even the student-state read', async () => {
    let called = 0;
    const lw = { call: async () => { called += 1; return {}; } } as any;
    const result = await runDigestTick(lw, cfgFor(mkdtempSync(join(tmpdir(), 'lwh-sched-'))), { now: at(23) });
    expect(result).toBe('quiet');
    expect(called).toBe(0);
  });

  it('a delivered digest writes the ledger so the same decay never re-notifies', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-sched-'));
    const notify = async () => true;
    const first = await runDigestTick(makeLw(), cfgFor(vault), { now: at(12), notify });
    expect(first).toBe('notified');
    const ledger = JSON.parse(readFileSync(join(vault, '.harness', 'notify.json'), 'utf8'));
    expect(Object.keys(ledger)).toHaveLength(1);
    // Second tick, same state: the ledger already carries it.
    expect(await runDigestTick(makeLw(), cfgFor(vault), { now: at(12), notify })).toBe('nothing-due');
  });

  it('an UNDELIVERED digest leaves no ledger — the next tick must retry, not forget', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-sched-'));
    const notify = async () => false;
    expect(await runDigestTick(makeLw(), cfgFor(vault), { now: at(12), notify })).toBe('undelivered');
    expect(existsSync(join(vault, '.harness', 'notify.json'))).toBe(false);
    // Delivery recovers on a later tick and only then persists.
    expect(await runDigestTick(makeLw(), cfgFor(vault), { now: at(13), notify: async () => true })).toBe('notified');
  });

  it('a healthy student is four kinds of silence apart from a broken notifier', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-sched-'));
    const healthy = { call: async (_t: string, args: any) =>
      args?.slug ? { detail: { level: 'mastered', effective: 'mastered', last_reinforced: new Date(2026, 6, 26).toISOString() } } : { ok: {} } } as any;
    expect(await runDigestTick(healthy, cfgFor(vault), { now: at(12), notify: async () => true })).toBe('nothing-due');
  });
});
