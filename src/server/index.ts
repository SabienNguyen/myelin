import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import cron from 'node-cron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { Loreweaver } from './mcp.js';
import { buildRestRoutes } from './restRoutes.js';
import { buildChatRoute } from './chatRoute.js';
import { buildIngestRoutes } from './ingestRoutes.js';
import { startScheduler } from './scheduler.js';
import { AnkiClient } from './anki/client.js';
import { syncInbound, backlogDays } from './anki/inbound.js';
import { ensureCompileDrain, sweepInterruptedConversions } from './ingest.js';
import { sendNotification } from './notify.js';

const cfg = loadConfig();
const lw = await Loreweaver.connect(cfg);
const anki = new AnkiClient();
startScheduler(lw, cfg);
sweepInterruptedConversions(cfg.vault); // restarts orphan in-flight conversions — mark them honestly
// Drain any chapters left 'pending' from a previous run (e.g. converted but not yet compiled
// before a restart) — no button press required.
if (cfg.autoCompile !== false) ensureCompileDrain(lw, cfg);

// ISO 8601 week key (e.g. "2026-W28") — used to nudge about an Anki backlog at most once/week,
// sharing the same once-per-event ledger file the daily digest scheduler writes to.
function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

const notifyLedgerPath = join(cfg.vault, '.harness', 'notify.json');
function loadNotifyLedger(): Record<string, true> {
  return existsSync(notifyLedgerPath) ? JSON.parse(readFileSync(notifyLedgerPath, 'utf8')) : {};
}
function saveNotifyLedger(ledger: Record<string, true>): void {
  mkdirSync(join(cfg.vault, '.harness'), { recursive: true });
  writeFileSync(notifyLedgerPath, JSON.stringify(ledger));
}

async function ankiTick(): Promise<void> {
  await syncInbound(lw, anki, cfg).catch(console.error);
  const up = await anki.isUp();
  if (up || backlogDays(cfg.vault) <= cfg.schedule.ankiBacklogNudgeDays) return;
  const key = `anki|backlog|${isoWeekKey(new Date())}`;
  const ledger = loadNotifyLedger();
  if (ledger[key]) return;
  // Ledger only on delivery — a headless boot's failed notify-send must retry next tick.
  if (await sendNotification('Loreweaver', 'Anki reviews are piling up — open Anki to catch up.')) {
    ledger[key] = true;
    saveNotifyLedger(ledger);
  }
}

cron.schedule(`*/${cfg.schedule.ankiSyncMinutes} * * * *`, () => ankiTick(), { noOverlap: true });
ankiTick().catch(console.error); // once at boot

const app = new Hono();
app.route('/', buildRestRoutes(lw, cfg, {
  student: cfg.student, tutor: cfg.models.tutor.model, autoCompile: cfg.autoCompile,
}, anki));
app.route('/', buildChatRoute(lw, cfg));
app.route('/', buildIngestRoutes(lw, cfg));
serve({ fetch: app.fetch, port: cfg.port });
console.log(`loreweaver-harness on :${cfg.port}`);
