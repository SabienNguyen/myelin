// The built-in coding sandbox: /api/gap/ladder and /api/gap/run served from THIS process, with
// code execution in a killable child (runner.ts).
//
// This exists because the external the-gap sidecar is a separate service, absent by default — and
// for most of this app's life that meant a fresh install had no way to run code at all. The
// harness now ships one exercise and the machinery to grade it, so `code_exercise` works out of
// the box; a configured `gap.url` still routes to the full external sidecar instead (mined
// artifacts, more patterns), taking precedence over this (index.ts decides).
//
// Same wire contract as the sidecar (the Pinned Contract in
// docs/superpowers/plans/2026-07-20-gap-integration.md), same answer-integrity invariant:
// reference_answer is stripped for every non-worked_example rung before serialization, and there
// is no second, unstripped endpoint.

import { Hono } from 'hono';
import type { GapLadderPayload } from '../gapProxy.js';
import { runInChild } from './runner.js';
import {
  STREAM_CONSUMER_CASES, STREAM_CONSUMER_ENTRY, STREAM_CONSUMER_LADDER, STREAM_CONSUMER_RUNGS,
  stressCases, type BuiltinRung, type SuiteCase,
} from './streamConsumer.js';

export interface BuiltinExercise {
  ladder: typeof STREAM_CONSUMER_LADDER;
  rungs: BuiltinRung[];
  cases: SuiteCase[];
  entryPoint: string;
}

/** One exercise today. Adding a pattern means adding an entry — the run route below derives the
 *  pattern from the posted rungId's `<pattern>:<template>` shape, so nothing else changes. */
const EXERCISES: Record<string, BuiltinExercise> = {
  'stream-consumer': {
    ladder: STREAM_CONSUMER_LADDER,
    rungs: STREAM_CONSUMER_RUNGS,
    cases: STREAM_CONSUMER_CASES,
    entryPoint: STREAM_CONSUMER_ENTRY,
  },
};

const DEFAULT_PATTERN = 'stream-consumer';

/** The GET /api/gap/ladder payload — with the answer stripped where it must be. Also consumed
 *  directly by gapHelp.ts via gapProxy.fetchLadderPayload's builtin fallback, so the help route
 *  reads rung data through the same stripped shape as the browser. */
export function builtinLadderPayload(pattern = DEFAULT_PATTERN): GapLadderPayload {
  const ex = EXERCISES[pattern];
  if (!ex) throw new Error(`no built-in exercise for pattern "${pattern}"`);
  return {
    ladder: ex.ladder,
    // INVARIANT: strip reference_answer for every non-worked_example rung before serializing.
    rungs: ex.rungs.map((r) => (r.template === 'worked_example' ? r : { ...r, reference_answer: '' })),
    mined: [],
  };
}

function exerciseForRung(rungId: unknown): BuiltinExercise | undefined {
  const pattern = typeof rungId === 'string' && rungId.includes(':')
    ? rungId.slice(0, rungId.indexOf(':'))
    : DEFAULT_PATTERN;
  return EXERCISES[pattern];
}

export function buildBuiltinGapRoutes() {
  const app = new Hono();

  app.get('/api/gap/ladder', (c) => c.json(builtinLadderPayload()));

  app.post('/api/gap/run', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.code !== 'string') {
      return c.json({ error: 'code must be a string' }, 400);
    }
    const ex = exerciseForRung(body.rungId);
    if (!ex) return c.json({ error: `no built-in exercise for rung "${body.rungId}"` }, 404);

    // Scratch run: the learner's own input, their own output, NO expected value anywhere — leaks
    // nothing and carries no evidence penalty. Same body-dispatch as the sidecar, so the client
    // needs no change.
    if (typeof body.input === 'string') {
      console.log(`[gap] scratch rung=${body.rungId} inputBytes=${body.input.length}`);
      return c.json(await runInChild({
        kind: 'scratch', code: body.code, entryPoint: ex.entryPoint, input: body.input,
      }));
    }

    // Stress: same assertions, same bytes, hostile read boundaries.
    if (body.stress === true) {
      const cases = stressCases(ex.cases);
      console.log(`[gap] STRESS rung=${body.rungId} cases=${cases.length}`);
      const out = await runInChild({ kind: 'suite', code: body.code, entryPoint: ex.entryPoint, cases });
      console.log(`[gap]   -> pass=${out.pass} ${out.results.filter((r) => !r.pass).length} failing`);
      return c.json({ ...out, stressed: true });
    }

    console.log(`[gap] run rung=${body.rungId} mode=${body.mode ?? '-'} bytes=${body.code.length}`);
    const out = await runInChild({ kind: 'suite', code: body.code, entryPoint: ex.entryPoint, cases: ex.cases });
    console.log(`[gap]   -> pass=${out.pass} ${out.results.map((r) => (r.pass ? '+' : '-')).join('')}${out.syntaxError ? ' syntaxError' : ''}`);
    return c.json(out);
  });

  return app;
}
