import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDigest, inQuietHours, runDigestTick } from '../src/server/scheduler.js';

// The snapshot get_student_state returns: each entry already carries `slipped` and `days_left`,
// the memory layer's own decay numbers (computeDigest no longer re-derives them). days_left is null
// once a page has slipped or is not decaying at all.
const state = {
  derivatives: { level: 'mastered', effective: 'mastered', last_reinforced: '2026-06-01', slipped: false, days_left: 4 },   // no
  'chain-rule': { level: 'mastered', effective: 'mastered', last_reinforced: '2026-06-05', slipped: false, days_left: 8 },  // no
  'loss-functions': { level: 'mastered', effective: 'mastered', last_reinforced: '2026-05-30', slipped: false, days_left: 2 }, // soon
  'gradient-descent': { level: 'practicing', effective: 'exposed', last_reinforced: '2026-05-01', slipped: true, days_left: null }, // decayed
};

describe('computeDigest', () => {
  it('flags decays-soon and decayed, not healthy pages', () => {
    const { items } = computeDigest(state as any, {});
    expect(items.map((i) => `${i.slug}:${i.kind}`).sort()).toEqual([
      'gradient-descent:decayed', 'loss-functions:decays-soon',
    ]);
  });
  it('honours a rubric-held page\'s shorter window instead of re-deriving 21 days', () => {
    // The bug this fix closes: a practicing page resting on a rubric verdict decays at 14 days, so
    // the layer reports days_left 2 while a level-based re-derivation (21-day practicing window)
    // would compute ~9 and stay silent. Consuming the reported number fires the heads-up on time.
    const rubric = { 'equilibrium': {
      level: 'practicing', effective: 'practicing', last_reinforced: '2026-06-30', slipped: false, days_left: 2,
    } };
    const { items } = computeDigest(rubric as any, {});
    expect(items.map((i) => `${i.slug}:${i.kind}`)).toEqual(['equilibrium:decays-soon']);
  });
  it('ledger suppresses repeat notifications for the same event', () => {
    const first = computeDigest(state as any, {});
    const second = computeDigest(state as any, first.newLedger);
    expect(second.items).toEqual([]);
  });
  it('re-notifies after re-reinforcement resets the window', () => {
    const first = computeDigest(state as any, {});
    // Re-reinforcement moves last_reinforced, so the ledger key changes — a genuinely new event,
    // even for the same slug and kind. The layer reports it as decaying-soon again.
    const bumped = { 'loss-functions': {
      ...state['loss-functions'], last_reinforced: '2026-08-22', days_left: 2,
    } };
    const later = computeDigest(bumped as any, first.newLedger);
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
  // One call, one map: get_student_state(no slug) already carries slipped/days_left per page.
  const decayedMap = {
    'loss-functions': {
      level: 'mastered', effective: 'practicing', last_reinforced: '2026-06-01',
      slipped: true, days_left: null,
    },
  };
  const makeLw = () => ({ call: async () => decayedMap }) as any;
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
    const healthy = { call: async () => ({
      ok: { level: 'mastered', effective: 'mastered', last_reinforced: '2026-06-26', slipped: false, days_left: 30 },
    }) } as any;
    expect(await runDigestTick(healthy, cfgFor(vault), { now: at(12), notify: async () => true })).toBe('nothing-due');
  });
});
