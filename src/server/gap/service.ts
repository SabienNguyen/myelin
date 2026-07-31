// The built-in coding sandbox: /api/gap/ladder and /api/gap/run served from THIS process, with
// code execution in a killable child (runner.ts).
//
// This exists because an early design routed code exercises through a separate external the-gap
// service, absent by default — for most of this app's life that meant a fresh install had no way
// to run code at all. The harness now ships one exercise and the machinery to grade it, so
// `code_exercise` works out of the box; the external sidecar option was later removed outright
// (docs/superpowers/plans/2026-07-20-gap-integration.md's header note) — this is the only sandbox
// there is now.
//
// Same wire contract the sidecar once had (the Pinned Contract in
// docs/superpowers/plans/2026-07-20-gap-integration.md), same answer-integrity invariant:
// reference_answer is stripped for every non-worked_example rung before serialization, and there
// is no second, unstripped endpoint.

import { Hono } from 'hono';
import type { GapLadderPayload } from '../gapProxy.js';
import {
  approvedGenerated, familyOf, generatedRungParts, generateExercise, listGenerated,
  setGeneratedStatus, toSuiteCases, type GeneratedExercise, type GeneratedFamily,
  type StreamGeneratedCase,
} from './generated.js';
import { environmentStatuses, withEnvironment } from './environment.js';
import { availableRuntimes, runProgram, runtimeStatuses, scratchProgram, type ExecCase } from './exec.js';
import { gradeManifest, scratchManifest, type ManifestAssertion } from './manifest.js';
import { runInChild, type FnCase } from './runner.js';
import {
  STREAM_CONSUMER_CASES, STREAM_CONSUMER_ENTRY, STREAM_CONSUMER_LADDER, STREAM_CONSUMER_RUNGS,
  runnableReference, stressCases, type BuiltinRung, type SuiteCase,
} from './streamConsumer.js';
import { canonicalJSON } from './canonical.js';

export type BuiltinExercise = {
  ladder: typeof STREAM_CONSUMER_LADDER;
  rungs: BuiltinRung[];
  entryPoint: string;
} & (
  | { family: 'stream'; cases: SuiteCase[] }
  | { family: 'function'; cases: FnCase[] }
  | { family: 'manifest'; cases: ManifestAssertion[] }
  | { family: 'exec'; cases: ExecCase[]; runtime: string; environment?: string }
);

/** One suite run, spelled per family so every call site dispatches identically. Manifests never
 *  touch the child (data, not code); exec spawns the named runtime per case (exec.ts), inside a
 *  fresh composed environment when the exercise names one (environment.ts). */
function runSuite(ex: BuiltinExercise, code: string, entryPoint: string, cases?: SuiteCase[] | FnCase[] | ManifestAssertion[] | ExecCase[]) {
  if (ex.family === 'manifest') return Promise.resolve(gradeManifest(code, (cases ?? ex.cases) as ManifestAssertion[]));
  if (ex.family === 'exec') {
    const suite = (cases ?? ex.cases) as ExecCase[];
    return ex.environment
      ? withEnvironment(ex.environment, (envVars) => runProgram(ex.runtime, code, suite, envVars))
        .catch((e): ReturnType<typeof runProgram> => Promise.resolve({
          pass: false, results: [], syntaxError: e instanceof Error ? e.message : String(e),
        }))
      : runProgram(ex.runtime, code, suite);
  }
  return ex.family === 'function'
    ? runInChild({ kind: 'suite', family: 'function', code, entryPoint, cases: (cases ?? ex.cases) as FnCase[] })
    : runInChild({ kind: 'suite', code, entryPoint, cases: (cases ?? ex.cases) as SuiteCase[] });
}

/** How a function case reads when shown to a learner: the call they are predicting. */
const callPreview = (entryPoint: string, c: FnCase) =>
  `${entryPoint}(${c.args.map((a) => JSON.stringify(a)).join(', ')})`;

/** One exercise today. Adding a pattern means adding an entry — the run route below derives the
 *  pattern from the posted rungId's `<pattern>:<template>` shape, so nothing else changes. */
const EXERCISES: Record<string, BuiltinExercise> = {
  'stream-consumer': {
    ladder: STREAM_CONSUMER_LADDER,
    rungs: STREAM_CONSUMER_RUNGS,
    family: 'stream',
    cases: STREAM_CONSUMER_CASES,
    entryPoint: STREAM_CONSUMER_ENTRY,
  },
};

const DEFAULT_PATTERN = 'stream-consumer';

/** Which patterns have a real ladder here — the derivable signal appliedRoutes.ts and
 *  seedPatternPages use to say a coding exercise EXISTS for a page. Approved generated exercises
 *  count exactly like the hand-built one: to everything downstream they ARE exercises, the
 *  review gate having already done its work. */
export function builtinPatterns(vault?: string): string[] {
  const generated = vault ? approvedGenerated(vault).map((e) => e.pattern) : [];
  return [...Object.keys(EXERCISES), ...generated];
}

/** An approved generated exercise, lifted into the same shape the hand-built registry uses: one
 *  full_body rung, statement as the visible_pre comment, the harness's own hostile chunking. */
function liftGenerated(g: GeneratedExercise): BuiltinExercise {
  const parts = generatedRungParts(g);
  const family: GeneratedFamily = familyOf(g);
  const cases = family === 'manifest' ? (g.cases as ManifestAssertion[])
    : family === 'exec' ? (g.cases as ExecCase[])
      : family === 'function' ? (g.cases as FnCase[])
        : toSuiteCases(g.cases as StreamGeneratedCase[]);
  return {
    ladder: { pattern: g.pattern, targetArtifactId: g.pattern, siblingArtifactId: g.pattern, rungs: [`${g.pattern}:full_body`] },
    rungs: [{
      id: `${g.pattern}:full_body`,
      template: 'full_body',
      artifactId: g.pattern,
      entryPoint: g.entryPoint,
      // Predictable cases: the first, same as the hand-built ladder — stream inputs are authored
      // as text so they read cleanly; a function case reads as the call expression itself; an
      // exec case reads as its stdin. A manifest has no output to predict (assertions are the
      // whole grade), so no gate.
      predictCases: family !== 'manifest' && cases.length ? [cases[0].name] : [],
      visible_pre: parts.visible_pre,
      visible_post: parts.visible_post,
      reference_answer: g.reference,
      prose: g.prose,
      scaffold: parts.scaffold,
    }],
    family,
    ...(family === 'exec' ? { runtime: g.runtime ?? 'node', ...(g.environment ? { environment: g.environment } : {}) } : {}),
    cases,
    entryPoint: g.entryPoint,
  } as BuiltinExercise;
}

function lookupExercise(pattern: string, vault?: string): BuiltinExercise | undefined {
  if (EXERCISES[pattern]) return EXERCISES[pattern];
  if (!vault) return undefined;
  const g = approvedGenerated(vault).find((e) => e.pattern === pattern);
  return g ? liftGenerated(g) : undefined;
}

/** The GET /api/gap/ladder payload — with the answer stripped where it must be. Also consumed
 *  directly by gapHelp.ts via gapProxy.fetchLadderPayload's builtin fallback, so the help route
 *  reads rung data through the same stripped shape as the browser. */
export function builtinLadderPayload(pattern = DEFAULT_PATTERN, vault?: string): GapLadderPayload {
  const ex = lookupExercise(pattern, vault);
  if (!ex) throw new Error(`no built-in exercise for pattern "${pattern}"`);
  const preview = (name: string) => {
    const c = (ex.cases as (SuiteCase | FnCase | ExecCase)[]).find((k) => k.name === name);
    if (!c) return null;
    // Stream: the case's bytes as readable text (predictCases are restricted to cases where this
    // is clean). Function: the call expression — args ARE the input. Exec: the program's stdin
    // and argv, spelled the way a shell user reads them.
    const inputPreview = ex.family === 'function'
      ? callPreview(ex.entryPoint, c as FnCase)
      : ex.family === 'exec'
        ? [
          (c as ExecCase).args?.length ? `argv: ${(c as ExecCase).args!.join(' ')}` : null,
          `stdin:\n${(c as ExecCase).stdin || '(empty)'}`,
        ].filter(Boolean).join('\n')
        : new TextDecoder().decode(Uint8Array.from((c as SuiteCase).chunks.flat()));
    return { caseName: name, inputPreview };
  };
  return {
    ladder: ex.ladder,
    // INVARIANT: strip reference_answer for every non-worked_example rung before serializing.
    // `predict` carries the QUESTIONS (case inputs); answers only ever leave via /api/gap/predict.
    rungs: ex.rungs.map((r) => ({
      ...(r.template === 'worked_example' ? r : { ...r, reference_answer: '' }),
      predict: r.predictCases.map(preview).filter(Boolean),
    })),
    mined: [],
    family: ex.family,
  };
}

function exerciseForRung(rungId: unknown, vault?: string): BuiltinExercise | undefined {
  const pattern = typeof rungId === 'string' && rungId.includes(':')
    ? rungId.slice(0, rungId.indexOf(':'))
    : DEFAULT_PATTERN;
  return lookupExercise(pattern, vault);
}

export interface BuiltinGapOpts {
  /** Where generated exercises live (vault/.harness/generated-exercises). Absent -> only the
   *  hand-built exercise exists, which is how the unit tests run vault-less. */
  vault?: string;
  /** The model seam for POST /api/gap/generate — injectable so tests use a stub and production
   *  wires the compile role. Absent -> the generate route answers 501 rather than pretending. */
  generate?: (prompt: string) => Promise<string>;
  modelName?: string;
}

export function buildBuiltinGapRoutes(opts: BuiltinGapOpts = {}) {
  const app = new Hono();
  const { vault } = opts;

  app.get('/api/gap/ladder', (c) => {
    const pattern = c.req.query('pattern');
    // Unknown or absent pattern falls back to the default ladder — the shape the external
    // sidecar's pattern-less /api/ladder has always had.
    try {
      return c.json(builtinLadderPayload(pattern && lookupExercise(pattern, vault) ? pattern : DEFAULT_PATTERN, vault));
    } catch {
      return c.json(builtinLadderPayload(DEFAULT_PATTERN, vault));
    }
  });

  /** Every pattern this sandbox can serve — what the Library's Practice section lists. The
   *  external-sidecar proxy has no such route (its Practice fallback derives one row from the
   *  ladder), so the client treats a 404 here as "single-pattern mode", not an error. */
  app.get('/api/gap/patterns', (c) => c.json({
    patterns: [
      // `builtin` marks the factory-shipped demo ladders. The Practice section hides an untouched
      // builtin (same rule the graph applies to its seeded stub page): a demo the learner never
      // asked for is infrastructure, not their curriculum. Generated patterns exist because the
      // learner did something, so they carry no flag and always list.
      ...Object.keys(EXERCISES).map((p) => ({ pattern: p, builtin: true })),
      ...(vault ? approvedGenerated(vault).map((g) => ({ pattern: g.pattern, title: g.title })) : []),
    ],
  }));

  /** The review gate's surface: everything generated, gates and status visible. */
  app.get('/api/gap/generated', (c) => c.json({
    exercises: listGenerated(vault ?? '').map((e) => ({
      pattern: e.pattern, title: e.title, family: familyOf(e), runtime: e.runtime, status: e.status,
      verification: e.verification, generatedAt: e.generatedAt, generatedBy: e.generatedBy,
      cases: e.cases.length,
    })),
  }));

  app.put('/api/gap/generated/:pattern', async (c) => {
    if (!vault) return c.json({ error: 'no vault configured' }, 500);
    const body = await c.req.json().catch(() => ({}));
    if (body?.status !== 'approved' && body?.status !== 'rejected') {
      return c.json({ error: 'status must be approved or rejected' }, 400);
    }
    const updated = setGeneratedStatus(vault, c.req.param('pattern'), body.status);
    if (!updated) return c.json({ error: `no generated exercise "${c.req.param('pattern')}"` }, 404);
    if (body.status === 'approved' && !updated.verification.ok) {
      // Approval recorded, service still refuses: verification is not a formality a human can wave.
      return c.json({ ...updated, warning: 'approved, but verification gates failed — it will NOT be served' });
    }
    return c.json(updated);
  });

  app.post('/api/gap/generate', async (c) => {
    if (!vault) return c.json({ error: 'no vault configured' }, 500);
    if (!opts.generate) return c.json({ error: 'no generation model configured on this route' }, 501);
    const body = await c.req.json().catch(() => ({}));
    const pattern = String(body?.pattern ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (!pattern) return c.json({ error: 'pattern is required' }, 400);
    if (lookupExercise(pattern, vault) || listGenerated(vault).some((e) => e.pattern === pattern)) {
      return c.json({ error: `an exercise for "${pattern}" already exists` }, 409);
    }
    const family: GeneratedFamily = body?.family === 'function' ? 'function'
      : body?.family === 'manifest' ? 'manifest'
        : body?.family === 'exec' ? 'exec' : 'stream';
    try {
      const ex = await generateExercise(vault, pattern, String(body?.description ?? ''), {
        generate: opts.generate, modelName: opts.modelName,
      }, family, typeof body?.runtime === 'string' ? body.runtime : undefined,
      typeof body?.environment === 'string' ? body.environment : undefined);
      console.log(`[gap] generated "${pattern}" -> ${ex.status} (${ex.verification.gates.filter((g) => !g.ok).length} failed gates)`);
      return c.json(ex, ex.status === 'rejected' ? 422 : 200);
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500);
    }
  });

  /** Which runtimes the exec family can serve on THIS machine — what a tutor (or the UI) should
   *  consult before offering "practice this in Python". node is always present (it is the app).
   *  `statuses` carries the reason-plus-fix for everything unavailable (daemon down, image not
   *  pulled), so an integration can SAY what to do instead of hiding the runtime. */
  app.get('/api/gap/environments', async (c) => c.json({
    runtimes: await availableRuntimes(),
    statuses: await runtimeStatuses(),
    // The service-environment registry (redis, postgres, …) with per-entry availability and the
    // fix when unavailable — same shape of honesty as the runtime statuses above.
    environments: await environmentStatuses(),
  }));

  /**
   * Predict-the-output, graded server-side — comprehension before production.
   *
   * The learner is shown a case's INPUT and asked what the finished function yields, before they
   * write it. The reference runs HERE, in the same killable child as every other run, and only the
   * verdict returns — the expected output never reaches the client until the learner has missed
   * twice, at which point it is teaching material rather than an answer key (predictions carry no
   * evidence, so there is nothing to launder).
   *
   * The rung's own entryPoint is what makes this work for the worked example's SIBLING artifact —
   * the exact case that blocked this feature when one entry point per ladder was assumed.
   */
  app.post('/api/gap/predict', async (c) => {
    const body = await c.req.json().catch(() => null);
    const ex = exerciseForRung(body?.rungId, vault);
    const rung = ex?.rungs.find((r) => r.id === body?.rungId);
    if (!ex || !rung) return c.json({ error: `no rung "${body?.rungId}"` }, 404);
    const suiteCase = (ex.cases as (SuiteCase | FnCase | ExecCase)[]).find((k) => k.name === body?.caseName && rung.predictCases.includes(k.name));
    if (!suiteCase) return c.json({ error: `no predictable case "${body?.caseName}" on this rung` }, 404);
    if (!Array.isArray(body.prediction)) return c.json({ error: 'prediction must be an array of strings' }, 400);

    const run = await runSuite(ex, runnableReference(rung), rung.entryPoint, [suiteCase] as SuiteCase[] & FnCase[]);
    if (run.syntaxError || run.results.length === 0 || !run.results[0].pass) {
      // Degrade loudly: a reference that cannot pass its own case is a content bug, and grading a
      // learner's prediction against it would be grading against a lie.
      return c.json({ error: `reference failed its own case: ${run.syntaxError ?? run.results[0]?.actual ?? 'no result'}` }, 500);
    }
    // The reference just passed this exact case, so the case's `expect` IS the actual output.
    let actual: string[];
    let pass: boolean;
    if (ex.family === 'function') {
      // One value, not a sequence. The learner types it as they'd write it — `6`, `"abc"`, or bare
      // abc — so normalize through JSON-parse-or-string before deep-comparing; grading a correct
      // prediction wrong on quoting would teach quoting, not the subject.
      const expectVal = (suiteCase as FnCase).expect;
      const typed = String(body.prediction[0] ?? '').trim();
      let predictedVal: unknown = typed;
      try { predictedVal = JSON.parse(typed); } catch { /* a bare string is a fine way to say a string */ }
      // Canonical compare: predicting { b, a } for a { a, b } return is correct — grading it wrong
      // on key order would teach key order, not the subject (the same reason quoting is normalized).
      pass = canonicalJSON(predictedVal) === canonicalJSON(expectVal);
      actual = [JSON.stringify(expectVal)];
    } else if (ex.family === 'exec') {
      // The prediction is the program's stdout: compare the typed lines against the expected
      // output line-by-line, whitespace-trimmed — the same normalization the judge itself applies.
      const expected = (suiteCase as ExecCase).expect.replace(/\r\n/g, '\n').trimEnd();
      const typed = body.prediction.map((p: unknown) => String(p).trimEnd()).join('\n').trimEnd();
      pass = typed === expected;
      actual = expected.split('\n');
    } else {
      actual = (suiteCase as SuiteCase).expect;
      const predicted = body.prediction.map((p: unknown) => String(p).trim()).filter((p: string) => p !== '');
      pass = JSON.stringify(predicted) === JSON.stringify(actual);
    }
    const attempt = Number(body.attempt ?? 1);
    console.log(`[gap] predict rung=${body.rungId} case="${body.caseName}" attempt=${attempt} pass=${pass}`);
    return c.json({
      pass,
      // Revealed only after a second miss — and even then framed as teaching, not as a key.
      ...(pass || attempt >= 2 ? { actual } : {}),
    });
  });

  app.post('/api/gap/run', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.code !== 'string') {
      return c.json({ error: 'code must be a string' }, 400);
    }
    const ex = exerciseForRung(body.rungId, vault);
    if (!ex) return c.json({ error: `no built-in exercise for rung "${body.rungId}"` }, 404);

    // Scratch run: the learner's own input, their own output, NO expected value anywhere — leaks
    // nothing and carries no evidence penalty. Same body-dispatch as the sidecar, so the client
    // needs no change.
    if (typeof body.input === 'string') {
      console.log(`[gap] scratch rung=${body.rungId} inputBytes=${body.input.length}`);
      // Manifest scratch ignores `input`: the interesting question is "what does MY YAML parse
      // to", and the YAML is the code itself. Exec scratch feeds the input as the program's stdin
      // — inside the exercise's environment when it has one, because "poke my own program at the
      // real service" is exactly what scratch exists for.
      if (ex.family === 'manifest') return c.json(scratchManifest(body.code));
      if (ex.family === 'exec') {
        if (ex.environment) {
          const out = await withEnvironment(ex.environment, (envVars) => scratchProgram(ex.runtime, body.code, body.input, envVars))
            .catch((e) => ({ pass: false, results: [], scratch: true as const, runtimeError: e instanceof Error ? e.message : String(e) }));
          return c.json(out);
        }
        return c.json(await scratchProgram(ex.runtime, body.code, body.input));
      }
      return c.json(await runInChild(ex.family === 'function'
        ? { kind: 'scratch', family: 'function', code: body.code, entryPoint: ex.entryPoint, input: body.input }
        : { kind: 'scratch', code: body.code, entryPoint: ex.entryPoint, input: body.input }));
    }

    // Stress: same assertions, same bytes, hostile read boundaries. Re-chunking is a STREAM idea —
    // for a function or manifest suite there is nothing adversarial to vary, so the run comes back
    // without `stressed` and the client reports stress as unsupported rather than pretending.
    if (body.stress === true && ex.family === 'stream') {
      const cases = stressCases(ex.cases);
      console.log(`[gap] STRESS rung=${body.rungId} cases=${cases.length}`);
      const out = await runInChild({ kind: 'suite', code: body.code, entryPoint: ex.entryPoint, cases });
      console.log(`[gap]   -> pass=${out.pass} ${out.results.filter((r) => !r.pass).length} failing`);
      return c.json({ ...out, stressed: true });
    }

    console.log(`[gap] run rung=${body.rungId} mode=${body.mode ?? '-'} bytes=${body.code.length}`);
    const out = await runSuite(ex, body.code, ex.entryPoint);
    console.log(`[gap]   -> pass=${out.pass} ${out.results.map((r) => (r.pass ? '+' : '-')).join('')}${out.syntaxError ? ' syntaxError' : ''}`);
    return c.json(out);
  });

  return app;
}
