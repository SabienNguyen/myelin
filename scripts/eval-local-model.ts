/**
 * Rails-generation eval for a candidate (usually local) model, run OUTSIDE the app:
 *
 *   npm run eval:model -- ollama:qwen3:8b               # 12 quick_check trials
 *   npm run eval:model -- ollama:qwen3:8b --n 20        # more trials
 *   npm run eval:model -- ollama:qwen3:8b --feedback    # also exercise the feedback schema
 *
 * Each trial mirrors one rails generation exactly: the REAL prompt builder and schema from
 * src/server/rails.ts, routed through chatModelFor (so OLLAMA_BASE_URL / OPENAI_COMPAT_* mean what
 * they mean in the app, constrained decoding and its fallback included), against small bundled
 * fixture pages. Recorded per trial: schema-valid on the first try / needed the one retry rails
 * allows / would have fallen back to the template question; latency per call; expected∈choices
 * violations. Output: a compact per-trial table plus totals on stdout. Progress goes to stderr.
 */
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import type { HarnessConfig } from '../src/server/config.js';
import { generateStructured, type ChatModel } from '../src/server/llm/index.js';
import { chatModelFor } from '../src/server/models.js';
import {
  buildCheckPrompt, buildFeedbackPrompt, railsCheckSchema, railsFeedbackSchema,
} from '../src/server/rails.js';

// ---------------------------------------------------------------------------
// Fixtures: three small pages spanning the levels that flip the framing rule
// (unseen/exposed = calibration framing, practicing = plain framing).
// ---------------------------------------------------------------------------

const FIXTURES = [
  {
    slug: 'bayes-theorem', title: 'Bayes’ theorem', level: 'exposed',
    body: `# Bayes’ theorem

Bayes’ theorem turns a conditional probability around: P(A|B) = P(B|A) · P(A) / P(B).

The pieces have names worth keeping straight. P(A) is the prior — what you believed before seeing
the evidence. P(B|A) is the likelihood — how probable the evidence is if A holds. P(A|B) is the
posterior — the updated belief. P(B) normalizes, and expands as P(B|A)P(A) + P(B|¬A)P(¬A).

The classic trap is base-rate neglect: a 99%-accurate test for a disease that 1 in 10,000 people
have still yields mostly false positives, because the prior P(A) is tiny and multiplies through.`,
  },
  {
    slug: 'tcp-handshake', title: 'The TCP three-way handshake', level: 'unseen',
    body: `# The TCP three-way handshake

A TCP connection starts with three segments. The client sends SYN with an initial sequence number
x. The server answers SYN-ACK: its own sequence number y, and an acknowledgment x+1. The client
finishes with ACK y+1, and the connection is established on both sides.

Why three and not two? Both sides must know that BOTH directions work and both sequence numbers
are agreed. Two segments would leave the server unsure its own sequence number ever arrived.

A half-open connection — SYN received, SYN-ACK sent, final ACK never arrives — is what SYN-flood
attacks exploit: the server holds state for connections that will never complete.`,
  },
  {
    slug: 'light-reactions', title: 'Light-dependent reactions', level: 'practicing',
    body: `# Light-dependent reactions

The light-dependent reactions of photosynthesis run on the thylakoid membrane. Photosystem II
absorbs light and splits water — the source of the oxygen plants release — feeding electrons into
the transport chain. The chain pumps protons into the thylakoid lumen, and ATP synthase lets them
back out, making ATP. Photosystem I re-energizes the electrons to reduce NADP+ to NADPH.

The products that matter downstream are ATP and NADPH: the Calvin cycle spends both to fix CO2,
and it runs in the stroma, not on the membrane. Light is required here precisely because
chlorophyll’s excited electrons, not glucose, are what this stage produces.`,
  },
];

// ---------------------------------------------------------------------------
// Pure accounting + formatting (unit-tested; nothing below performs I/O).
// ---------------------------------------------------------------------------

export interface TrialCall {
  ms: number;
  /** Absent on a call whose object validated (and passed the expected∈choices check). */
  error?: string;
}

export interface Trial {
  kind: 'quick_check' | 'feedback';
  page: string;
  /** Mirrors rails: 'first' = valid on the first call, 'retry' = the one retry saved it,
   * 'fallback' = rails would have used the deterministic template. */
  outcome: 'first' | 'retry' | 'fallback';
  calls: TrialCall[];
  /** The model produced an `expected` that is not one of `choices` on some attempt — the failure
   * mode schema constraints cannot catch, hence its own column. */
  expectedViolation: boolean;
}

export interface Totals {
  n: number;
  first: number;
  retry: number;
  fallback: number;
  violations: number;
  calls: number;
  meanMs: number;
  medianMs: number;
}

export function summarize(trials: Trial[]): Totals {
  const calls = trials.flatMap((t) => t.calls);
  const sorted = calls.map((c) => c.ms).sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return {
    n: trials.length,
    first: trials.filter((t) => t.outcome === 'first').length,
    retry: trials.filter((t) => t.outcome === 'retry').length,
    fallback: trials.filter((t) => t.outcome === 'fallback').length,
    violations: trials.filter((t) => t.expectedViolation).length,
    calls: calls.length,
    meanMs: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
    medianMs: sorted.length
      ? Math.round(sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2)
      : 0,
  };
}

function formatTable(rows: string[][]): string {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  return rows
    .map((r) => r.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd())
    .join('\n');
}

export function formatReport(trials: Trial[]): string {
  const rows = [
    ['#', 'kind', 'page', 'outcome', 'latency', 'expected∈choices'],
    ...trials.map((t, i) => [
      String(i + 1),
      t.kind,
      t.page,
      t.outcome,
      t.calls.map((c) => `${Math.round(c.ms)}ms`).join(' + '),
      t.expectedViolation ? 'VIOLATED' : 'ok',
    ]),
  ];
  const s = summarize(trials);
  const totals = `${s.n} trials — first try ${s.first}/${s.n}, retry ${s.retry}, `
    + `fallback ${s.fallback}; expected∉choices on ${s.violations}; `
    + `${s.calls} calls, median ${s.medianMs}ms, mean ${s.meanMs}ms`;
  return `${formatTable(rows)}\n\n${totals}`;
}

export function parseArgs(argv: string[]): { modelId: string; n: number; feedback: boolean } | null {
  let modelId = '';
  let n = 12;
  let feedback = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--feedback') feedback = true;
    else if (a === '--n') {
      n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) return null;
    } else if (!a.startsWith('-') && !modelId) modelId = a;
    else return null;
  }
  return modelId ? { modelId, n, feedback } : null;
}

// ---------------------------------------------------------------------------
// Trial runner.
// ---------------------------------------------------------------------------

/** A failure that means the endpoint is not there at all — every further trial would fail the
 * same way, so the run aborts with a message naming the variable to check instead of reporting
 * a page of fallbacks as if the model had been measured. */
function unreachableMessage(modelId: string, e: unknown): string | null {
  const cause = String((e as { cause?: { code?: string } })?.cause?.code ?? '');
  const network = (e instanceof TypeError && /fetch failed/i.test(e.message))
    || /ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT/.test(cause);
  if (!network) return null;
  const hint = modelId.startsWith('ollama:')
    ? `is Ollama running? OLLAMA_BASE_URL=${process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1 (default)'}`
    : modelId.startsWith('openai:')
      ? `is the endpoint up? OPENAI_COMPAT_BASE_URL=${process.env.OPENAI_COMPAT_BASE_URL ?? '(unset)'}`
      : 'is the network up?';
  return `cannot reach the model endpoint (${cause || 'fetch failed'}) — ${hint}`;
}

class UnreachableEndpoint extends Error {}

interface AttemptOutcome {
  ok: boolean;
  /** What the retry prompt should name; set on schema failures and expected∉choices alike. */
  error?: string;
  violation?: boolean;
}

async function runTrial(
  model: ChatModel,
  modelId: string,
  kind: Trial['kind'],
  fixture: typeof FIXTURES[number],
): Promise<Trial> {
  const calls: TrialCall[] = [];

  const attempt = async <T>(
    prompt: string, schema: z.ZodType<T>, schemaName: string,
    check?: (object: T) => string | null,
  ): Promise<AttemptOutcome> => {
    const t0 = performance.now();
    try {
      const { object } = await generateStructured({ model, prompt, schema, schemaName });
      const violation = check ? check(object) : null;
      calls.push({ ms: performance.now() - t0, ...(violation ? { error: violation } : {}) });
      return violation ? { ok: false, error: violation, violation: true } : { ok: true };
    } catch (e) {
      const unreachable = unreachableMessage(modelId, e);
      if (unreachable) throw new UnreachableEndpoint(unreachable);
      const msg = e instanceof Error ? e.message : String(e);
      calls.push({ ms: performance.now() - t0, error: msg });
      return { ok: false, error: msg };
    }
  };

  if (kind === 'feedback') {
    // Mirrors generateRailsFeedback: one call, no retry — a failure goes straight to the
    // machine-grade fallback.
    const prompt = buildFeedbackPrompt([{
      question: `What does the page “${fixture.title}” establish?`,
      answer: 'the first option',
      grade: {
        verdict: 'correct', source: 'mechanical',
        detail: 'answer matched expected', evidence: [],
      },
    }]);
    const one = await attempt(prompt, railsFeedbackSchema, 'rails_feedback');
    return {
      kind, page: fixture.slug, calls,
      outcome: one.ok ? 'first' : 'fallback',
      expectedViolation: false,
    };
  }

  // Mirrors generateRailsQuickCheck: one generation, one retry with the rejection appended, then
  // the deterministic fallback.
  const prompt = buildCheckPrompt(
    { slug: fixture.slug, title: fixture.title, level: fixture.level, reason: 'lesson' },
    { title: fixture.title, body: fixture.body },
    [], [],
  );
  const checkExpected = (o: z.infer<typeof railsCheckSchema>) =>
    o.choices.includes(o.expected)
      ? null
      : `expected ${JSON.stringify(o.expected)} is not one of choices — copy one choice verbatim`;
  const first = await attempt(prompt, railsCheckSchema, 'rails_quick_check', checkExpected);
  if (first.ok) return { kind, page: fixture.slug, outcome: 'first', calls, expectedViolation: false };
  const second = await attempt(
    `${prompt}\n\nYour previous attempt was rejected: ${first.error}. Return a corrected quick check.`,
    railsCheckSchema, 'rails_quick_check', checkExpected,
  );
  return {
    kind, page: fixture.slug, calls,
    outcome: second.ok ? 'retry' : 'fallback',
    expectedViolation: Boolean(first.violation || second.violation),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('usage: npm run eval:model -- <model-id> [--n <trials>] [--feedback]\n'
      + '       npm run eval:model -- ollama:qwen3:8b --n 20');
    process.exit(2);
  }
  // chatModelFor is the app's own routing, so ollama:/openai: ids resolve exactly as a lesson
  // would — including the openai:-without-base-URL error, which is already clear.
  const cfg = {
    vault: '.', student: 'eval', models: { tutor: { model: args.modelId } },
  } as unknown as HarnessConfig;
  const model = chatModelFor('tutor', cfg);

  const plan: { kind: Trial['kind']; fixture: typeof FIXTURES[number] }[] = [];
  for (let i = 0; i < args.n; i++) plan.push({ kind: 'quick_check', fixture: FIXTURES[i % FIXTURES.length] });
  if (args.feedback) {
    for (let i = 0; i < Math.min(args.n, FIXTURES.length); i++) {
      plan.push({ kind: 'feedback', fixture: FIXTURES[i % FIXTURES.length] });
    }
  }

  const trials: Trial[] = [];
  for (const [i, step] of plan.entries()) {
    process.stderr.write(`trial ${i + 1}/${plan.length} (${step.kind} on ${step.fixture.slug})…\n`);
    trials.push(await runTrial(model, args.modelId, step.kind, step.fixture));
  }
  console.log(`\n${args.modelId}\n${formatReport(trials)}`);
}

// Import-safe: the unit tests import the accounting/formatting exports above without running an
// eval — main() fires only when this file IS the invoked script.
const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(e instanceof UnreachableEndpoint ? e.message : e);
    process.exit(1);
  });
}
