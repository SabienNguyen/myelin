import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import cron from 'node-cron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configSource, explicitModelRoles, loadConfig } from './config.js';
import { applyCredentials, credentialsPath } from './credentials.js';
import { applyRoute, readRoute } from './signin.js';
import { buildSetupRoutes, needsApiKey } from './setupRoutes.js';
import { buildStaticRoutes } from './staticRoutes.js';
import { Engram } from './mcp.js';
import { buildRestRoutes } from './restRoutes.js';
import { buildChatRoute } from './chatRoute.js';
import { buildIngestRoutes } from './ingestRoutes.js';
import { buildGapRoutes } from './gapProxy.js';
import { buildBuiltinGapRoutes } from './gap/service.js';
import { compileGenerate } from './gap/generateSeam.js';
import { buildGapHelpRoute } from './gapHelp.js';
import { seedPatternPages } from './seedPatternPages.js';
import { startScheduler } from './scheduler.js';
import { AnkiClient } from './anki/client.js';
import { syncInbound, backlogDays } from './anki/inbound.js';
import { ensureCompileDrain, sweepInterruptedConversions } from './ingest.js';
import { sendNotification } from './notify.js';

const cfg = loadConfig();

/**
 * Boot preflight. Everything a first run needs that can be done without asking, done — and
 * everything it needs that CANNOT be defaulted, said out loud before the server starts serving.
 *
 * The old first-run experience was a zod error listing fifteen missing config fields. This prints
 * what it resolved and what is still missing, in the order a person would need to act on it.
 */
function preflight(): void {
  const src = configSource();
  console.log(src.found ? `config: ${src.path}` : `config: none found at ${src.path} — using defaults`);

  mkdirSync(join(cfg.vault, 'pages'), { recursive: true }); // a fresh vault is just an empty dir
  console.log(`vault:  ${cfg.vault}`);

  // The MCP server is spawned lazily by Engram.connect, and a missing entry point surfaces
  // there as an opaque transport error, so name it here where the fix is obvious.
  const entry = cfg.engram.args[cfg.engram.args.length - 1];
  if (!entry || !existsSync(entry)) {
    console.error(`\nCannot find the Engram MCP server at:\n  ${entry}\n`
      + 'Fix by any one of: installing it as a dependency, putting a `engram` checkout beside '
      + 'this one, setting ENGRAM_ENTRY, or setting `engram.command`/`args` in '
      + 'harness.config.json.\n');
  } else {
    console.log(`memory: ${cfg.engram.command} ${cfg.engram.args.join(' ')}`);
  }

  const route = readRoute();
  if (route) console.log(`auth:   ${route === 'subscription' ? 'Claude subscription (local claude login)' : 'Anthropic API key'}`);

  const roles = needsApiKey(cfg);
  if (roles.length && !process.env.ANTHROPIC_API_KEY) {
    console.error(`\nNo ANTHROPIC_API_KEY. These roles need one: ${roles.join(', ')}.\n`
      + `Enter it in the app (it saves to ${credentialsPath()}) or export it before starting.\n`);
  }
}

applyCredentials(); // saved key -> env, before anything constructs a model. The env always wins.
// A learner who signed in with their Claude subscription chose model ids too — apply that before
// anything reads cfg.models, and before the preflight decides whether to nag about a missing key.
applyRoute(cfg, explicitModelRoles(), readRoute());
preflight();

const lw = await Engram.connect(cfg);
// I3: seed the sandbox's ladder patterns as vault pages (idempotent, mechanical content — see
// seedPatternPages.ts for the single-writer rationale). Unconditional now that the sandbox ships
// built-in: there is always at least one ladder to give a page to.
await seedPatternPages(lw, cfg);
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
  if (!existsSync(notifyLedgerPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(notifyLedgerPath, 'utf8'));
    // Shared notify.json (scheduler.ts writes it too): a crash mid-write truncates it, and this
    // dedup ledger is losslessly resettable — degrade rather than throw into the anki-backlog tick.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
  if (await sendNotification('Myelin', 'Anki reviews are piling up — open Anki to catch up.')) {
    ledger[key] = true;
    saveNotifyLedger(ledger);
  }
}

cron.schedule(`*/${cfg.schedule.ankiSyncMinutes} * * * *`, () => ankiTick(), { noOverlap: true });
ankiTick().catch(console.error); // once at boot

const app = new Hono();
// `tutor` is deliberately NOT in this snapshot — restRoutes reads it from cfg per request, because
// signing in with a Claude subscription changes it while the app is running.
app.route('/', buildRestRoutes(lw, cfg, {
  student: cfg.student, autoCompile: cfg.autoCompile,
}, anki));
app.route('/', buildChatRoute(lw, cfg));
app.route('/', buildIngestRoutes(lw, cfg));
// The coding sandbox: the built-in service (gap/service.ts) unless an external the-gap sidecar
// is configured, in which case the proxy to it wins — see gapProxy.ts's buildGapRoutes doc.
app.route('/', buildGapRoutes(cfg, () => buildBuiltinGapRoutes({
  vault: cfg.vault,
  generate: compileGenerate(cfg),
  modelName: cfg.models.compile.model,
})));
app.route('/', buildGapHelpRoute(lw, cfg));
// First-run readiness + the one thing a first run must supply. Mounted last so it is reachable
// even if a feature route above is disabled.
app.route('/', buildSetupRoutes(cfg));
// Built client last of all, because its SPA fallback answers everything that did not match an API
// route above. Absent in dev (Vite owns the client then) — see staticRoutes.ts.
const staticFiles = buildStaticRoutes();
if (staticFiles.found) app.route('/', staticFiles.app);
serve({ fetch: app.fetch, port: cfg.port });
console.log(staticFiles.found
  ? `Myelin is running — open http://localhost:${cfg.port}`
  : `myelin API on :${cfg.port} (no built client; run \`npm run dev:client\`)`);
