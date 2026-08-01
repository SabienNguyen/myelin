// The token-spend ledger: every model call appends one JSONL row under vault/.harness/ (the same
// single-writer territory sessionStore uses), and /api/usage summarizes it per role. Recording is
// fire-and-forget — a ledger failure must never cost a turn.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Usage } from './llm/index.js';

/** Where a call's spend is charged. Matches config.ts's model-role names, plus 'help' — gap help
 * runs on the tutor's model but is its own spend line, or the tutor column would silently absorb
 * every in-IDE hint. */
export type UsageRole = 'tutor' | 'grader' | 'quiz_gen' | 'card_gen' | 'compile' | 'help';

export interface RoleTotals {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
}

export interface UsageSummary {
  today: Partial<Record<UsageRole, RoleTotals>>;
  week: Partial<Record<UsageRole, RoleTotals>>;
  /** cacheRead / (in + cacheRead) over the window — the share of input tokens served from the
   * prompt cache. Anthropic bills cache reads separately from fresh input; this reports the
   * split, it does not price it. Null until any input tokens exist. */
  cacheHitShare: number | null;
}

const ledgerPath = (vault: string) => join(vault, '.harness', 'usage.jsonl');

/** Append one usage row. All-zero usage still writes — mock and scripted models report zeros,
 * and a zero row is data (the call happened) — but any filesystem failure is swallowed with a
 * console.error: the ledger is telemetry and must never break the turn it measures. */
/** Warn when a call's input exceeded the context the role's model was configured with.
 *
 *  A twelve-turn session on a local 32k model sat around 11k input per turn — the history diet
 *  doing its job — and then one research turn sent 53,716. Ollama does not error on that: it
 *  truncates to fit, silently, and the turn is answered from whatever survived. The learner sees a
 *  worse answer with nothing to explain it.
 *
 *  Detection only, deliberately. Budgeting tool results against a model's window is a real feature
 *  and guessing at it would trade a rare bad answer for routinely truncated sources. Naming it in
 *  the log is what turns a silent degradation into something diagnosable. */
export function overContext(
  inputTokens: number | undefined, contextTokens: number | undefined,
): boolean {
  return Boolean(inputTokens && contextTokens && inputTokens > contextTokens);
}

export function recordUsage(
  vault: string,
  entry: { role: UsageRole; model: string; usage: Usage; contextTokens?: number },
): void {
  try {
    if (overContext(entry.usage.inputTokens, entry.contextTokens)) {
      console.error(
        `[context] ${entry.role} call sent ${entry.usage.inputTokens} tokens to ${entry.model}, `
        + `configured for ${entry.contextTokens} — the provider will have truncated it, so this `
        + 'answer was produced from an incomplete prompt',
      );
    }
    if (!vault) return; // some test fixtures carry no vault; nothing to record into
    mkdirSync(join(vault, '.harness'), { recursive: true });
    const row = {
      ts: new Date().toISOString(),
      role: entry.role,
      model: entry.model,
      in: entry.usage.inputTokens,
      out: entry.usage.outputTokens,
      cacheRead: entry.usage.cacheReadTokens,
      cacheWrite: entry.usage.cacheWriteTokens,
    };
    appendFileSync(ledgerPath(vault), `${JSON.stringify(row)}\n`);
  } catch (e) {
    console.error('[usage] record failed:', e instanceof Error ? e.message : e);
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function add(bucket: Partial<Record<UsageRole, RoleTotals>>, role: UsageRole, row: Record<string, unknown>) {
  const t = bucket[role] ?? (bucket[role] = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });
  t.in += num(row.in);
  t.out += num(row.out);
  t.cacheRead += num(row.cacheRead);
  t.cacheWrite += num(row.cacheWrite);
  t.calls += 1;
}

/** Per-role totals for today and the trailing `days` window (today included), plus the window's
 * overall cache-hit share. A corrupt line is skipped, never fatal — the ledger is append-only and
 * a crash mid-write leaves at most one torn tail line. `now` injected for day-window tests. */
export function readUsage(vault: string, opts: { days?: number; now?: () => Date } = {}): UsageSummary {
  const days = opts.days ?? 7;
  const now = (opts.now ?? (() => new Date()))();
  const summary: UsageSummary = { today: {}, week: {}, cacheHitShare: null };
  const p = ledgerPath(vault);
  let raw: string;
  try {
    if (!existsSync(p)) return summary;
    raw = readFileSync(p, 'utf8');
  } catch {
    return summary; // unreadable ledger reads as empty — same stance as recordUsage's swallow
  }
  const todayStr = now.toISOString().slice(0, 10);
  const cutoff = now.getTime() - days * 86_400_000;
  let inSum = 0;
  let cacheReadSum = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // torn or corrupt line: skip it, keep the rest of the ledger
    }
    const ts = typeof row?.ts === 'string' ? row.ts : '';
    const t = Date.parse(ts);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const role = row.role as UsageRole;
    add(summary.week, role, row);
    if (ts.slice(0, 10) === todayStr) add(summary.today, role, row);
    inSum += num(row.in);
    cacheReadSum += num(row.cacheRead);
  }
  const denom = inSum + cacheReadSum;
  summary.cacheHitShare = denom > 0 ? cacheReadSum / denom : null;
  return summary;
}
