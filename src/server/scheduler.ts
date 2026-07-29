import cron from 'node-cron';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessConfig } from './config.js';
import type { Engram } from './mcp.js';
import { sendNotification } from './notify.js';

export type Ledger = Record<string, true>; // key: `${slug}|${kind}|${last_reinforced}`
export interface DigestItem { slug: string; kind: 'decays-soon' | 'decayed'; message: string }

/**
 * Turn the student-state map into the digest lines a tick would notify, deduped against the ledger.
 *
 * `slipped` and `days_left` are read straight off each entry — they come from the memory layer,
 * computed where the decay windows actually live (engram's decayDaysLeft). This USED to
 * re-derive the countdown here from a local `{mastered:45, practicing:21}` table, which is blind to
 * the shorter window a rubric-held page rests on: such a page decays at 14 days, so its "decays
 * soon" heads-up (fired at ≤3 days left) was computed against 21 and never sent before the page had
 * already slipped. Consuming the layer's own number is the fix and the reason it exposes one.
 */
export function computeDigest(state: Record<string, any>, ledger: Ledger) {
  const items: DigestItem[] = [];
  const newLedger: Ledger = { ...ledger };
  for (const [slug, m] of Object.entries(state)) {
    const push = (kind: DigestItem['kind'], message: string) => {
      const key = `${slug}|${kind}|${m.last_reinforced}`;
      if (!newLedger[key]) { newLedger[key] = true; items.push({ slug, kind, message }); }
    };
    if (m.slipped) push('decayed', `${slug} slipped to ${m.effective} — review to restore`);
    else if (m.days_left != null && m.days_left <= 3) push('decays-soon', `${slug} decays in ${m.days_left}d`);
  }
  return { items, newLedger };
}

const ledgerPath = (vault: string) => join(vault, '.harness', 'notify.json');
const loadLedger = (vault: string): Ledger => {
  const p = ledgerPath(vault);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Ledger) : {};
  } catch {
    // A dedup ledger truncated by a crash mid-write is losslessly resettable — a notice already sent
    // may re-fire once, which is far better than the digest throwing here every tick until the file
    // is repaired by hand. Every other ledger in this codebase degrades the same way.
    return {};
  }
};

/** Is `hour` inside the quiet window? Handles windows that SPAN MIDNIGHT ([22, 8] means 22:00
 *  through 07:59) — the branch a naive range check silently gets wrong. */
export function inQuietHours(hour: number, [qStart, qEnd]: [number, number]): boolean {
  return qStart > qEnd ? hour >= qStart || hour < qEnd : hour >= qStart && hour < qEnd;
}

/** One digest tick, extracted from the cron wiring so tests can run it with an injected clock
 *  and notifier. Returns what happened — 'quiet' | 'nothing-due' | 'notified' | 'undelivered' —
 *  so the caller (and a test) can tell the four silences apart. */
export async function runDigestTick(
  lw: Engram, cfg: HarnessConfig,
  deps: { now?: () => Date; notify?: typeof sendNotification } = {},
): Promise<'quiet' | 'nothing-due' | 'notified' | 'undelivered'> {
  const now = deps.now ?? (() => new Date());
  const notify = deps.notify ?? sendNotification;
  if (inQuietHours(now().getHours(), cfg.schedule.quietHours)) return 'quiet';
  // The map already carries per-page `slipped` and `days_left` (get_student_state computes both as
  // of now), so one call is the whole input — no per-slug refetch, which fetched a `detail` shape
  // that dropped exactly those two fields and forced the old local re-derivation.
  const state = await lw.call('get_student_state', { student: cfg.student });
  const { items, newLedger } = computeDigest(state, loadLedger(cfg.vault));
  if (!items.length) return 'nothing-due';
  // Only mark the ledger when the notification actually reached the desktop — a headless
  // send (boot-before-login) fails and must retry on a later tick, not vanish.
  const delivered = await notify('Myelin', items.map((i) => i.message).join('\n'));
  if (!delivered) return 'undelivered';
  mkdirSync(join(cfg.vault, '.harness'), { recursive: true });
  writeFileSync(ledgerPath(cfg.vault), JSON.stringify(newLedger));
  return 'notified';
}

export function startScheduler(lw: Engram, cfg: HarnessConfig) {
  // .catch for the same reason ankiTick has one (index.ts): runDigestTick awaits MCP calls, a
  // notifier, and a ledger read, any of which can reject — an unhandled rejection in a background
  // cron tick has no business reaching the process. A logged miss retries on the next tick.
  return cron.schedule(
    `0 ${cfg.schedule.digestHour} * * *`,
    () => { runDigestTick(lw, cfg).catch(console.error); },
    { noOverlap: true },
  );
}
