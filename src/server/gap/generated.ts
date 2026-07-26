// Generated exercises — backlog item 2, built on the seam the plan named: a model MAY author what
// is checkable or discardable; a model MUST NOT be what decides whether the learner passed. The
// real suite, run in the sandbox's killable child, stays the only grader.
//
// The plan's blocking question ("confirm the-gap's on-disk artifact contract before writing any
// emitter") dissolved when the sandbox moved into this repo: generated exercises feed the built-in
// registry directly, in a format this file owns.
//
// Scope, stated plainly: generated exercises target the family the built-in runner actually
// executes — async generators over byte chunks (SSE, NDJSON, line protocols, framing). That is one
// family, not all of programming; it is also the family where the runner can enforce the gauntlet
// property MECHANICALLY, because the model authors case INPUTS AS TEXT and never controls the
// chunking. We slice the bytes adversarially ourselves, so a generated suite cannot be
// chunk-aligned even if the model tried.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInChild } from './runner.js';
import { scaffoldFor, type SuiteCase } from './streamConsumer.js';

export interface GeneratedCase { name: string; inputText: string; expect: string[] }

export interface GeneratedExercise {
  pattern: string;
  title: string;
  entryPoint: string;
  /** The problem statement, emitted as comment lines above the scaffold. */
  statement: string;
  reference: string;
  cases: GeneratedCase[];
  prose: { context_line: string; hint: string; success_line: string };
  status: 'pending' | 'approved' | 'rejected';
  verification: VerificationReport;
  generatedBy: string;
  generatedAt: string;
}

export interface VerificationReport {
  ok: boolean;
  gates: { gate: string; ok: boolean; detail: string }[];
}

/** The model never chooses chunk boundaries: every case's bytes are sliced at a stride that does
 *  not align with lines, which is the entire point of the pattern family. */
export function toSuiteCases(cases: GeneratedCase[]): SuiteCase[] {
  return cases.map((c) => {
    const bytes = [...new TextEncoder().encode(c.inputText)];
    const chunks: number[][] = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));
    return { name: c.name, chunks, expect: c.expect };
  });
}

const statementComment = (statement: string) =>
  statement.split('\n').map((l) => `// ${l}`.trimEnd()).join('\n');

export function generatedRungParts(ex: Pick<GeneratedExercise, 'statement' | 'entryPoint'>) {
  const visible_pre = statementComment(ex.statement);
  const visible_post = '';
  return { visible_pre, visible_post, scaffold: scaffoldFor(visible_pre, visible_post) };
}

/**
 * The self-verification gate — the plan's B2, and the whole defence against the whole risk ("a
 * vacuous generated suite mints false mastery"). Every gate is mechanical, and every gate runs the
 * real child runner. An exercise that fails ANY gate is rejected with the failing gate named, and
 * an unverified exercise is never surfaced.
 */
export async function verifyExercise(
  ex: Pick<GeneratedExercise, 'entryPoint' | 'statement' | 'reference' | 'cases'>,
): Promise<VerificationReport> {
  const gates: VerificationReport['gates'] = [];
  const suite = toSuiteCases(ex.cases);
  const push = (gate: string, ok: boolean, detail: string) => gates.push({ gate, ok, detail });

  if (ex.cases.length < 3) {
    push('suite-size', false, `${ex.cases.length} cases — a gauntlet needs at least 3`);
    return { ok: false, gates };
  }
  push('suite-size', true, `${ex.cases.length} cases`);

  // Gate 1: the reference passes 100% of its own suite, under OUR chunking.
  const refRun = await runInChild({ kind: 'suite', code: ex.reference, entryPoint: ex.entryPoint, cases: suite });
  push('reference-passes', refRun.pass,
    refRun.pass ? 'reference passes all cases'
      : `reference fails: ${refRun.syntaxError ?? refRun.results.filter((r) => !r.pass).map((r) => r.name).join('; ')}`);

  // Gate 2: a do-nothing implementation must FAIL. A suite that passes it grades nothing — this is
  // the check that catches a vacuous suite before it can mint false mastery.
  const vacuous = `async function* ${ex.entryPoint}(chunks) { for await (const c of chunks) { /* consume */ } }`;
  const vacRun = await runInChild({ kind: 'suite', code: vacuous, entryPoint: ex.entryPoint, cases: suite });
  push('rejects-empty-implementation', !vacRun.pass,
    vacRun.pass ? 'a do-nothing implementation PASSES this suite — it grades nothing'
      : 'the suite fails an empty implementation');

  // Gate 3: the answer-stripped scaffold must not pass either (otherwise the exercise ships solved).
  const { scaffold } = generatedRungParts(ex as GeneratedExercise);
  const scafRun = await runInChild({ kind: 'suite', code: scaffold, entryPoint: ex.entryPoint, cases: suite });
  push('scaffold-does-not-pass', !scafRun.pass,
    scafRun.pass ? 'the scaffold already passes — the exercise is pre-solved' : 'scaffold fails, as it should');

  // Gate 4: test names must be requirements, not answer keys. Mechanical: no case name contains
  // one of its own expected values.
  const leaks = ex.cases.filter((c) =>
    c.expect.some((e) => e.length > 2 && c.name.toLowerCase().includes(e.toLowerCase())));
  push('names-do-not-leak-answers', leaks.length === 0,
    leaks.length ? `case name leaks its answer: ${leaks.map((l) => `"${l.name}"`).join(', ')}` : 'no expected value appears in a case name');

  return { ok: gates.every((g) => g.ok), gates };
}

// ── disk store: the review gate's substrate ────────────────────────────────────────────────────

export function generatedDir(vault: string): string {
  return join(vault, '.harness', 'generated-exercises');
}

export function saveGenerated(vault: string, ex: GeneratedExercise): void {
  mkdirSync(generatedDir(vault), { recursive: true });
  writeFileSync(join(generatedDir(vault), `${ex.pattern}.json`), `${JSON.stringify(ex, null, 2)}\n`);
}

export function listGenerated(vault: string): GeneratedExercise[] {
  const dir = generatedDir(vault);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      return JSON.parse(readFileSync(join(dir, f), 'utf8')) as GeneratedExercise;
    } catch {
      return null;
    }
  }).filter((x): x is GeneratedExercise => x !== null);
}

/** Only APPROVED exercises ever reach a learner. Pending ones exist so a human can look at them —
 *  the plan's own warning: it took rendering the stand-in in a browser to notice a malformed
 *  scaffold, so generated content gets eyes before it gets learners. */
export function approvedGenerated(vault: string): GeneratedExercise[] {
  return listGenerated(vault).filter((e) => e.status === 'approved' && e.verification?.ok === true);
}

export function setGeneratedStatus(
  vault: string, pattern: string, status: 'approved' | 'rejected',
): GeneratedExercise | null {
  const found = listGenerated(vault).find((e) => e.pattern === pattern);
  if (!found) return null;
  // Approval cannot outrun verification: an exercise whose gates failed stays unservable no matter
  // what status is written, because approvedGenerated re-checks verification.ok.
  const next = { ...found, status };
  saveGenerated(vault, next);
  return next;
}

// ── generation: the model authors, the gates decide ────────────────────────────────────────────

export interface GenerateDeps {
  /** Injectable model call, same seam as grading.ts's GradingDeps — testable with a stub. */
  generate: (prompt: string) => Promise<string>;
  now?: () => Date;
  modelName?: string;
}

const GENERATION_PROMPT = (pattern: string, description: string) => `Author a coding exercise for the pattern "${pattern}".
${description ? `Context from the tutor: ${description}\n` : ''}
The exercise family is: an async generator function over an async iterable of Uint8Array byte
chunks, yielding strings. Chunk boundaries never align with logical boundaries — implementations
must buffer across reads. Your test inputs are plain TEXT; the harness slices them into hostile
chunks itself, so do not think about chunking.

Respond with ONLY valid JSON, no fences:
{
  "title": <short human title>,
  "entryPoint": <camelCase function name>,
  "statement": <3-6 line problem statement: what the function receives, what it yields, edge rules>,
  "reference": <the complete correct implementation as one string of JavaScript, an async generator named exactly entryPoint>,
  "cases": [4-6 of {"name": <what requirement this checks — never containing the answer>, "inputText": <the raw input text>, "expect": [<the strings yielded, in order>]}],
  "prose": {"context_line": <one line of framing>, "hint": <one nudge>, "success_line": <one line for after>}
}`;

/**
 * Generate, verify, store as PENDING. The result is never servable from here: it takes a human
 * approval (setGeneratedStatus) AND passing gates to reach a learner, in that order of importance.
 */
export async function generateExercise(
  vault: string, pattern: string, description: string, deps: GenerateDeps,
): Promise<GeneratedExercise> {
  const raw = await deps.generate(GENERATION_PROMPT(pattern, description));
  let parsed: any;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```json?\n?|```$/g, ''));
  } catch (e) {
    throw new Error(`the model did not return valid JSON: ${(e as Error).message}`);
  }
  const ex: GeneratedExercise = {
    pattern,
    title: String(parsed.title ?? pattern),
    entryPoint: String(parsed.entryPoint ?? 'parse'),
    statement: String(parsed.statement ?? ''),
    reference: String(parsed.reference ?? ''),
    cases: Array.isArray(parsed.cases) ? parsed.cases.map((c: any) => ({
      name: String(c.name ?? ''), inputText: String(c.inputText ?? ''),
      expect: Array.isArray(c.expect) ? c.expect.map(String) : [],
    })) : [],
    prose: {
      context_line: String(parsed.prose?.context_line ?? ''),
      hint: String(parsed.prose?.hint ?? ''),
      success_line: String(parsed.prose?.success_line ?? ''),
    },
    status: 'pending',
    verification: { ok: false, gates: [] },
    generatedBy: deps.modelName ?? 'unknown',
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  ex.verification = await verifyExercise(ex);
  // Failed gates are stored too — a rejected exercise with its failing gate named is how the
  // compile step stays debuggable. It is auto-rejected, not left pending, so nobody wastes a
  // review on something the machine already refused.
  if (!ex.verification.ok) ex.status = 'rejected';
  saveGenerated(vault, ex);
  return ex;
}
