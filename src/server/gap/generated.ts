// Generated exercises — backlog item 2, built on the seam the plan named: a model MAY author what
// is checkable or discardable; a model MUST NOT be what decides whether the learner passed. The
// real suite, run in the sandbox's killable child, stays the only grader.
//
// The plan's blocking question ("confirm the-gap's on-disk artifact contract before writing any
// emitter") dissolved when the sandbox moved into this repo: generated exercises feed the built-in
// registry directly, in a format this file owns.
//
// Two families:
//
//  - 'stream': async generators over byte chunks (SSE, NDJSON, line protocols, framing). The model
//    authors case INPUTS AS TEXT and never controls the chunking — we slice the bytes adversarially
//    ourselves, so a generated suite cannot be chunk-aligned even if the model tried.
//  - 'function': one plain function, args in, value out, deep-compared. This is the family that
//    makes "practice this as code" reachable from ANY page — statistics, chemistry, music theory,
//    text processing — because nearly every domain has some computation worth earning, and a
//    JSON-valued suite grades it mechanically with no model in the verdict.
//
// Both families keep the same defence: the model authors, the gates decide, the real suite in the
// killable child stays the only grader.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProgram, runtimeAvailable, runtimeFor, type ExecCase } from './exec.js';
import { gradeManifest, type ManifestAssertion } from './manifest.js';
import { runInChild, type FnCase } from './runner.js';
import { scaffoldFor, type SuiteCase } from './streamConsumer.js';

export type GeneratedFamily = 'stream' | 'function' | 'manifest' | 'exec';

export interface StreamGeneratedCase { name: string; inputText: string; expect: string[] }
export type GeneratedCase = StreamGeneratedCase | FnCase | ManifestAssertion | ExecCase;

export interface GeneratedExercise {
  pattern: string;
  title: string;
  /** Absent in files stored before the function family existed — read through familyOf(), which
   *  defaults it to 'stream', so no stored exercise needs migrating. */
  family?: GeneratedFamily;
  /** exec family only: which runtime runs the program ('node' | 'python3' | 'bash' | 'ruby'). */
  runtime?: string;
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

export const familyOf = (ex: Pick<GeneratedExercise, 'family'>): GeneratedFamily => ex.family ?? 'stream';

/** The model never chooses chunk boundaries: every case's bytes are sliced at a stride that does
 *  not align with lines, which is the entire point of the pattern family. */
export function toSuiteCases(cases: StreamGeneratedCase[]): SuiteCase[] {
  return cases.map((c) => {
    const bytes = [...new TextEncoder().encode(c.inputText)];
    const chunks: number[][] = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));
    return { name: c.name, chunks, expect: c.expect };
  });
}

// Comment syntax follows the language the learner writes in: JS families get //, manifests get #,
// exec follows its runtime's own comment prefix.
function commentPrefix(ex: Pick<GeneratedExercise, 'family' | 'runtime'>): string {
  const family = familyOf(ex);
  if (family === 'manifest') return '#';
  if (family === 'exec') return runtimeFor(ex.runtime ?? 'node')?.comment ?? '#';
  return '//';
}

export function generatedRungParts(ex: Pick<GeneratedExercise, 'statement' | 'entryPoint' | 'family' | 'runtime'>) {
  const family = familyOf(ex);
  const prefix = commentPrefix(ex);
  const visible_pre = ex.statement.split('\n').map((l) => `${prefix} ${l}`.trimEnd()).join('\n');
  const visible_post = '';
  const scaffold = family === 'manifest'
    ? `${visible_pre}\n# YOUR TURN — write the manifest below.\n`
    : family === 'exec'
      ? `${visible_pre}\n${prefix} YOUR TURN — write the whole program below.\n`
      : scaffoldFor(visible_pre, visible_post);
  return { visible_pre, visible_post, scaffold };
}

/**
 * The self-verification gate — the plan's B2, and the whole defence against the whole risk ("a
 * vacuous generated suite mints false mastery"). Every gate is mechanical, and every gate runs the
 * real child runner. An exercise that fails ANY gate is rejected with the failing gate named, and
 * an unverified exercise is never surfaced.
 */
export async function verifyExercise(
  ex: Pick<GeneratedExercise, 'entryPoint' | 'statement' | 'reference' | 'cases' | 'family' | 'runtime'>,
): Promise<VerificationReport> {
  const gates: VerificationReport['gates'] = [];
  const family = familyOf(ex);
  const push = (gate: string, ok: boolean, detail: string) => gates.push({ gate, ok, detail });

  if (ex.cases.length < 3) {
    push('suite-size', false, `${ex.cases.length} cases — a gauntlet needs at least 3`);
    return { ok: false, gates };
  }
  push('suite-size', true, `${ex.cases.length} cases`);

  const run = (code: string) => {
    if (family === 'manifest') return Promise.resolve(gradeManifest(code, ex.cases as ManifestAssertion[]));
    if (family === 'exec') return runProgram(ex.runtime ?? 'node', code, ex.cases as ExecCase[]);
    return family === 'function'
      ? runInChild({ kind: 'suite', family, code, entryPoint: ex.entryPoint, cases: ex.cases as FnCase[] })
      : runInChild({ kind: 'suite', code, entryPoint: ex.entryPoint, cases: toSuiteCases(ex.cases as StreamGeneratedCase[]) });
  };

  // Gate 1: the reference passes 100% of its own suite — under OUR chunking for streams, under
  // plain deep-compare for functions.
  const refRun = await run(ex.reference);
  push('reference-passes', refRun.pass,
    refRun.pass ? 'reference passes all cases'
      : `reference fails: ${refRun.syntaxError ?? refRun.results.filter((r) => !r.pass).map((r) => r.name).join('; ')}`);

  // Gate 2: a do-nothing implementation must FAIL. A suite that passes it grades nothing — this is
  // the check that catches a vacuous suite before it can mint false mastery. Per family because
  // "do nothing" has a different spelling: yield nothing, return undefined, or an empty file (a
  // manifest suite of only `absent` assertions passes an empty file — exactly what this catches).
  // For exec the vacuous program is an empty file: it runs, exits 0, prints nothing — so a suite
  // whose every case expects empty stdout is graded as vacuous, exactly right.
  const vacuous = family === 'manifest' || family === 'exec' ? ''
    : family === 'function'
      ? `function ${ex.entryPoint}() {}`
      : `async function* ${ex.entryPoint}(chunks) { for await (const c of chunks) { /* consume */ } }`;
  const vacRun = await run(vacuous);
  push('rejects-empty-implementation', !vacRun.pass,
    vacRun.pass ? 'a do-nothing implementation PASSES this suite — it grades nothing'
      : 'the suite fails an empty implementation');

  // Gate 3: the answer-stripped scaffold must not pass either (otherwise the exercise ships solved).
  const { scaffold } = generatedRungParts(ex as GeneratedExercise);
  const scafRun = await run(scaffold);
  push('scaffold-does-not-pass', !scafRun.pass,
    scafRun.pass ? 'the scaffold already passes — the exercise is pre-solved' : 'scaffold fails, as it should');

  // Gate 4: test names must be requirements, not answer keys. Mechanical: no case name contains
  // one of its own expected values (stream: any yielded string; function: the JSON of the value).
  // Function answers get word-boundary matching at length > 1 — they are often SHORT numbers
  // ("10"), which the stream rule's length > 2 substring check would wave straight through, and
  // which plain substring matching would false-flag inside "100".
  // Manifests are write-from-spec: the STATEMENT legitimately names every value ("3 replicas of
  // nginx:1.25"), because the skill graded is expressing the spec in correct YAML structure, not
  // recalling values. A leak gate would reject exactly the good exercises — so no answers to
  // check, and the gate passes vacuously for this family.
  const answersOf = (c: GeneratedCase): string[] => {
    if (family === 'manifest') return [];
    if (family === 'exec') return [(c as ExecCase).expect];
    return family === 'function'
      ? [JSON.stringify((c as FnCase).expect) ?? '']
      : (c as StreamGeneratedCase).expect;
  };
  // Function and exec answers are often SHORT scalars ("10", "30") — word-boundary matching at
  // length > 1; streams keep the substring rule their tests pin.
  const leaksIn = (name: string, answer: string): boolean => (family === 'function' || family === 'exec'
    ? answer.length > 1 && new RegExp(`(^|[^\\w.])${answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w.])`, 'i').test(name)
    : answer.length > 2 && name.toLowerCase().includes(answer.toLowerCase()));
  const leaks = ex.cases.filter((c) => answersOf(c).some((e) => leaksIn(c.name, e)));
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

// The manifest family: certification-style "write the resource this task describes". The prompt
// constrains the ASSERTIONS (dot paths into parsed YAML, mechanical ops) — the subject can be any
// system configured by structured documents, Kubernetes being the motivating one.
const MANIFEST_PROMPT = (pattern: string, description: string) => `Author a manifest-writing exercise for the pattern "${pattern}".
${description ? `Context from the tutor: ${description}\n` : ''}
The exercise family is: the learner is given an imperative task (the style of a CKA/CKAD exam
task) and writes a YAML manifest from scratch. Grading is mechanical: assertions resolve dot-paths
into the parsed YAML (arrays as [n], multi-document files as docs[n].path) and check them with one
of four operations: "eq" (deep equality against a JSON value), "exists", "absent", "matches" (a
regex against the string at the path). Include enough assertions to pin the task's real
requirements — kind, names, labels/selectors agreeing, the fields the task demands — and nothing
stylistic.

Respond with ONLY valid JSON, no fences:
{
  "title": <short human title>,
  "statement": <the task, 3-6 imperative lines, exam style: exactly what to create and with what properties>,
  "reference": <a complete correct YAML manifest as one string — it must satisfy every assertion>,
  "cases": [4-8 of {"name": <the requirement checked>, "path": <dot path>, "op": "eq"|"exists"|"absent"|"matches", "value": <JSON value or regex source, omit for exists/absent>}],
  "prose": {"context_line": <one line of framing>, "hint": <one nudge>, "success_line": <one line for after>}
}`;

// The generalist family: a whole program in a named runtime, judged on stdout. The prompt pins
// the judge contract (stdin/args in, exact stdout out, deterministic) and leaves the subject and
// language free.
const EXEC_PROMPT = (pattern: string, description: string, runtime: string) => `Author a coding exercise for the pattern "${pattern}".
${description ? `Context from the tutor: ${description}\n` : ''}
The exercise family is: the learner writes a COMPLETE PROGRAM for the ${runtime} runtime. Each test
case runs the program as its own process with a given stdin and argv, and compares stdout exactly
(trailing whitespace ignored). The program must be deterministic — no randomness, no clock, no
network, no files beyond stdin/stdout — and must exit 0 on success. Pick a task worth earning in
the subject named by the pattern and context, sized for one file.

Respond with ONLY valid JSON, no fences:
{
  "title": <short human title>,
  "statement": <3-6 line problem statement: input format on stdin/argv, output format on stdout, edge rules>,
  "reference": <the complete correct program as one string of ${runtime} source>,
  "cases": [4-6 of {"name": <what requirement this checks — never containing the answer>, "stdin": <input text, "" if unused>, "args": [<argv strings>], "expect": <the exact stdout>}],
  "prose": {"context_line": <one line of framing>, "hint": <one nudge>, "success_line": <one line for after>}
}`;

export interface GenerateDeps {
  /** Injectable model call, same seam as grading.ts's GradingDeps — testable with a stub. */
  generate: (prompt: string) => Promise<string>;
  now?: () => Date;
  modelName?: string;
}

const STREAM_PROMPT = (pattern: string, description: string) => `Author a coding exercise for the pattern "${pattern}".
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

// The any-domain family. The constraints that make it gradeable are stated to the model as
// constraints on the SUITE (JSON args, JSON expected value, deterministic), not on the subject —
// the subject can be whatever the learner is studying.
const FUNCTION_PROMPT = (pattern: string, description: string) => `Author a coding exercise for the pattern "${pattern}".
${description ? `Context from the tutor: ${description}\n` : ''}
The exercise family is: ONE plain JavaScript function. It takes JSON-representable arguments and
returns a JSON-representable value (number, string, boolean, null, array, or object). It must be
deterministic — no randomness, no Date, no I/O — and self-contained (standard built-ins like Math,
JSON, Array and String are available; nothing else is). The point of the exercise is the DOMAIN
computation named by the pattern and context, not JavaScript trivia: pick the computation a learner
of that subject should be able to earn by writing it.

Respond with ONLY valid JSON, no fences:
{
  "title": <short human title>,
  "entryPoint": <camelCase function name>,
  "statement": <3-6 line problem statement: what the function receives, what it returns, edge rules>,
  "reference": <the complete correct implementation as one string of JavaScript, a function named exactly entryPoint>,
  "cases": [4-6 of {"name": <what requirement this checks — never containing the answer>, "args": [<the arguments>], "expect": <the exact return value>}],
  "prose": {"context_line": <one line of framing>, "hint": <one nudge>, "success_line": <one line for after>}
}`;

/**
 * Generate, verify, store as PENDING. The result is never servable from here: it takes a human
 * approval (setGeneratedStatus) AND passing gates to reach a learner, in that order of importance.
 */
export async function generateExercise(
  vault: string, pattern: string, description: string, deps: GenerateDeps,
  family: GeneratedFamily = 'stream', runtime?: string,
): Promise<GeneratedExercise> {
  if (family === 'exec') {
    const rt = runtime ?? 'node';
    if (!runtimeFor(rt)) throw new Error(`unknown runtime "${rt}"`);
    // Degrade loudly at authoring time: an exercise for a runtime this machine lacks would pass
    // no gate and confuse everyone downstream.
    if (!(await runtimeAvailable(rt))) throw new Error(`${rt} is not installed on this machine`);
  }
  const prompt = family === 'exec' ? EXEC_PROMPT(pattern, description, runtime ?? 'node')
    : family === 'manifest' ? MANIFEST_PROMPT(pattern, description)
      : family === 'function' ? FUNCTION_PROMPT(pattern, description)
        : STREAM_PROMPT(pattern, description);
  const raw = await deps.generate(prompt);
  let parsed: any;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```json?\n?|```$/g, ''));
  } catch (e) {
    throw new Error(`the model did not return valid JSON: ${(e as Error).message}`);
  }
  // Per-family case coercion. Function args/expect pass through as parsed JSON — coercing them to
  // strings would silently change what the suite asserts.
  const cases: GeneratedCase[] = Array.isArray(parsed.cases)
    ? parsed.cases.map((c: any): GeneratedCase => {
      if (family === 'manifest') {
        const op = ['eq', 'exists', 'absent', 'matches'].includes(c.op) ? c.op : 'eq';
        return { name: String(c.name ?? ''), path: String(c.path ?? ''), op, ...(c.value === undefined ? {} : { value: c.value }) };
      }
      if (family === 'exec') {
        return {
          name: String(c.name ?? ''), stdin: String(c.stdin ?? ''),
          args: Array.isArray(c.args) ? c.args.map(String) : [], expect: String(c.expect ?? ''),
        };
      }
      if (family === 'function') {
        return { name: String(c.name ?? ''), args: Array.isArray(c.args) ? c.args : [], expect: c.expect ?? null };
      }
      return {
        name: String(c.name ?? ''), inputText: String(c.inputText ?? ''),
        expect: Array.isArray(c.expect) ? c.expect.map(String) : [],
      };
    })
    : [];
  const ex: GeneratedExercise = {
    pattern,
    title: String(parsed.title ?? pattern),
    family,
    ...(family === 'exec' ? { runtime: runtime ?? 'node' } : {}),
    entryPoint: String(parsed.entryPoint ?? (family === 'exec' ? 'main' : 'parse')),
    statement: String(parsed.statement ?? ''),
    reference: String(parsed.reference ?? ''),
    cases,
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
