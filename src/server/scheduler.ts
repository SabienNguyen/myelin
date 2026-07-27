import cron from 'node-cron';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DECAY, LEVELS, type MasteryLevel } from '../shared/loreweaver.js';
import type { HarnessConfig } from './config.js';
import type { Loreweaver } from './mcp.js';
import { sendNotification } from './notify.js';

export type Ledger = Record<string, true>; // key: `${slug}|${kind}|${last_reinforced}`
export interface DigestItem { slug: string; kind: 'decays-soon' | 'decayed'; message: string }

const WINDOW: Partial<Record<MasteryLevel, number>> = {
  mastered: DECAY.masteredDays, practicing: DECAY.practicingDays,
};

export function computeDigest(state: Record<string, any>, ledger: Ledger, now: Date) {
  const items: DigestItem[] = [];
  const newLedger: Ledger = { ...ledger };
  for (const [slug, m] of Object.entries(state)) {
    const decayed = LEVELS.indexOf(m.effective) < LEVELS.indexOf(m.level);
    const window = WINDOW[m.effective as MasteryLevel];
    const push = (kind: DigestItem['kind'], message: string) => {
      const key = `${slug}|${kind}|${m.last_reinforced}`;
      if (!newLedger[key]) { newLedger[key] = true; items.push({ slug, kind, message }); }
    };
    if (decayed) push('decayed', `${slug} slipped to ${m.effective} — review to restore`);
    else if (window) {
      const daysLeft = window - Math.floor((now.getTime() - new Date(m.last_reinforced).getTime()) / 86_400_000);
      if (daysLeft > 0 && daysLeft <= 3) push('decays-soon', `${slug} decays in ${daysLeft}d`);
    }
  }
  return { items, newLedger };
}

const ledgerPath = (vault: string) => join(vault, '.harness', 'notify.json');
const loadLedger = (vault: string): Ledger =>
  existsSync(ledgerPath(vault)) ? JSON.parse(readFileSync(ledgerPath(vault), 'utf8')) : {};

/** Is `hour` inside the quiet window? Handles windows that SPAN MIDNIGHT ([22, 8] means 22:00
 *  through 07:59) — the branch a naive range check silently gets wrong. */
export function inQuietHours(hour: number, [qStart, qEnd]: [number, number]): boolean {
  return qStart > qEnd ? hour >= qStart || hour < qEnd : hour >= qStart && hour < qEnd;
}

/** One digest tick, extracted from the cron wiring so tests can run it with an injected clock
 *  and notifier. Returns what happened — 'quiet' | 'nothing-due' | 'notified' | 'undelivered' —
 *  so the caller (and a test) can tell the four silences apart. */
export async function runDigestTick(
  lw: Loreweaver, cfg: HarnessConfig,
  deps: { now?: () => Date; notify?: typeof sendNotification } = {},
): Promise<'quiet' | 'nothing-due' | 'notified' | 'undelivered'> {
  const now = deps.now ?? (() => new Date());
  const notify = deps.notify ?? sendNotification;
  if (inQuietHours(now().getHours(), cfg.schedule.quietHours)) return 'quiet';
  const state = await lw.call('get_student_state', { student: cfg.student });
  const details: Record<string, any> = {};
  for (const slug of Object.keys(state)) {
    const d = await lw.call('get_student_state', { student: cfg.student, slug });
    if (d.detail) details[slug] = d.detail;
  }
  const { items, newLedger } = computeDigest(details, loadLedger(cfg.vault), now());
  if (!items.length) return 'nothing-due';
  // Only mark the ledger when the notification actually reached the desktop — a headless
  // send (boot-before-login) fails and must retry on a later tick, not vanish.
  const delivered = await notify('Loreweaver', items.map((i) => i.message).join('\n'));
  if (!delivered) return 'undelivered';
  mkdirSync(join(cfg.vault, '.harness'), { recursive: true });
  writeFileSync(ledgerPath(cfg.vault), JSON.stringify(newLedger));
  return 'notified';
}

export function startScheduler(lw: Loreweaver, cfg: HarnessConfig) {
  return cron.schedule(`0 ${cfg.schedule.digestHour} * * *`, async () => { await runDigestTick(lw, cfg); }, { noOverlap: true });
}
