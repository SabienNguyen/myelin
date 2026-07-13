import { describe, it, expect } from 'vitest';
import { computeDigest } from '../src/server/scheduler.js';

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
