// The built-in mining pass: "give it a repo link, learn to code in that codebase" — without the
// external the-gap checkout that defaultRunMiner shells out to, which a shipped desktop app does
// not have.
//
// Shape of the trick: the repo's own functions become the HIDDEN REFERENCES of function-family
// exercises. The model never authors the solution — the codebase already wrote it. The model
// authors only the problem statement and the test suite around the real function, and the same
// five gates that police every generated exercise verify the suite mechanically against the real
// implementation before a learner ever sees it. A suite the repo's own function cannot pass is
// rejected by the machine, not shipped.
//
// Candidate discovery is deliberately dumb and mechanical: top-level named functions, extracted by
// balanced-brace scan, qualified by actually EVALUATING them in the sandbox's killable child. A
// function that references anything outside itself fails qualification or fails gate 1 later —
// both mechanical, both fatal, no heuristics to argue with. TypeScript files are scanned too;
// annotated functions simply fail evaluation in the child's plain-JS vm and drop out.
//
// Python repos ride the SAME trick through the exec family (the function family's child runner is
// Node-only): a column-0 `def` becomes the hidden reference of a whole-program exercise — the
// extracted function plus a fixed JSON harness (stdin: JSON array of arguments; stdout: compact
// sorted-keys JSON of the return value). Qualification runs the bare source under python3 (syntax
// errors and module-scope external references fail there, mechanically), and the standard five
// exec gates verify the model-authored suite against the real function before review.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runProgram, runtimeStatus } from './exec.js';
import { runInChild } from './runner.js';
import {
  saveGenerated, verifyExercise, type GeneratedExercise,
} from './generated.js';

export interface RepoCandidate {
  name: string;
  source: string;
  /** repo-relative path, for provenance in the exercise title/statement. */
  file: string;
  lang: 'js' | 'py';
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'coverage', '.next', 'target']);
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx)$/;
const PY_EXT = /\.py$/;
const MAX_FILES = 400;
const MAX_FILE_BYTES = 200_000;
const MIN_LINES = 3;
const MAX_LINES = 60;

/** Top-level `function name(...) { ... }` (optionally exported/async) — balanced-brace extraction.
 *  Generators are skipped: the function family calls and deep-compares a return value, and an
 *  iterator never deep-equals a JSON expectation. */
export function extractFunctions(text: string, file: string): RepoCandidate[] {
  const out: RepoCandidate[] = [];
  const re = /^(?:export\s+)?(?:default\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Walk to the closing brace of the body from the first '{' after the parameter list.
    const open = text.indexOf('{', re.lastIndex);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) continue;
    // Strip the `export`/`default` keywords so the child can evaluate the declaration bare.
    const decl = text.slice(m.index, end + 1).replace(/^(?:export\s+)?(?:default\s+)?/, '');
    const lines = decl.split('\n').length;
    if (lines < MIN_LINES || lines > MAX_LINES) continue;
    out.push({ name: m[2], source: decl, file, lang: 'js' });
  }
  return out;
}

/** Column-0 `def name(...):` blocks, delimited by indentation (a Python body is every following
 *  line that is blank or indented). Methods are excluded by the column-0 anchor; decorated
 *  functions are skipped because the decorator (not extracted) changes behavior; `_private`
 *  names and generators are skipped — the harness json-dumps a RETURN value, and a generator
 *  object has none worth comparing. */
export function extractPythonFunctions(text: string, file: string): RepoCandidate[] {
  const lines = text.split('\n');
  const out: RepoCandidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(lines[i]);
    if (!m) continue;
    if (m[1].startsWith('_')) continue;
    let p = i - 1;
    while (p >= 0 && lines[p].trim() === '') p--;
    if (p >= 0 && lines[p].trim().startsWith('@')) continue;
    let end = i + 1;
    while (end < lines.length && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) end++;
    let last = end - 1;
    while (last > i && lines[last].trim() === '') last--;
    const decl = lines.slice(i, last + 1).join('\n');
    const n = last + 1 - i;
    if (n >= MIN_LINES && n <= MAX_LINES && !/\byield\b/.test(decl)) {
      out.push({ name: m[1], source: decl, file, lang: 'py' });
    }
    i = last;
  }
  return out;
}

/** Deep key-sort, so JS-side serialization of the model's `expect` value prints byte-identical to
 *  the harness's `json.dumps(..., separators=(",", ":"), sort_keys=True, ensure_ascii=False)`. */
const sortDeep = (v: unknown): unknown => Array.isArray(v) ? v.map(sortDeep)
  : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]))
    : v;
export const pyJson = (v: unknown): string => JSON.stringify(sortDeep(v)) ?? 'null';

/** The extracted function as a complete program: JSON array of arguments on stdin, compact
 *  sorted-keys JSON of the return value on stdout. `_n` folds integral floats to ints (and tuples
 *  to lists) before printing — Python's round() and friends return 33.0 where JS serializes 33,
 *  and without the fold every float-returning function would be rejected on formatting, not
 *  behavior. This exact contract goes in the exercise statement, so the learner's program and
 *  this reference are judged by the same bytes. */
export function pyReferenceProgram(c: RepoCandidate): string {
  return `${c.source}\n\nimport sys, json\n`
    + 'def _n(v):\n'
    + '    if isinstance(v, float) and v.is_integer(): return int(v)\n'
    + '    if isinstance(v, (list, tuple)): return [_n(x) for x in v]\n'
    + '    if isinstance(v, dict): return {k: _n(x) for k, x in v.items()}\n'
    + '    return v\n'
    + '_args = json.loads(sys.stdin.read() or "[]")\n'
    + `print(json.dumps(_n(${c.name}(*_args)), separators=(",", ":"), sort_keys=True, ensure_ascii=False))\n`;
}

export function findCandidates(repoPath: string): RepoCandidate[] {
  const found: RepoCandidate[] = [];
  let filesSeen = 0;
  const walk = (dir: string) => {
    if (filesSeen >= MAX_FILES) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (filesSeen >= MAX_FILES) return;
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      const isJs = CODE_EXT.test(entry);
      const isPy = PY_EXT.test(entry);
      if ((!isJs && !isPy) || /(\.(test|spec)\.|^test_|_test\.py$)/.test(entry) || st.size > MAX_FILE_BYTES) continue;
      filesSeen++;
      try {
        const text = readFileSync(full, 'utf8');
        const rel = relative(repoPath, full);
        found.push(...(isJs ? extractFunctions(text, rel) : extractPythonFunctions(text, rel)));
      } catch { /* unreadable file — skip */ }
    }
  };
  walk(repoPath);
  return found;
}

/** Does this extracted source, alone, evaluate and define its own name? JS runs in the killable
 *  child with an empty suite; Python runs the bare source as a program that must exit 0 printing
 *  nothing. Either way: syntax errors, TS annotations, and module-scope references to anything
 *  external all fail here, mechanically. */
export async function qualifies(c: RepoCandidate): Promise<boolean> {
  if (c.lang === 'py') {
    const run = await runProgram('python3', c.source, [{ name: 'defines-cleanly', stdin: '', args: [], expect: '' }]);
    return !run.syntaxError && run.pass;
  }
  const run = await runInChild({ kind: 'suite', family: 'function', code: c.source, entryPoint: c.name, cases: [] });
  return !run.syntaxError;
}

const AUTHOR_PROMPT = (repo: string, c: RepoCandidate) => `You are turning REAL code from the repository "${repo}" into a coding exercise.
The learner will be shown a problem statement (never this code) and must write a function with the
same name and behavior. The original function below stays hidden and is the reference the suite is
verified against.

// ${c.file}
${c.source}

Respond with ONLY valid JSON, no fences:
{
  "title": <short human title naming what the function does, not its name>,
  "statement": <3-6 line contract: parameters, return value, edge rules. Describe BEHAVIOR you can
    observe from the code; never describe the implementation or paste any of it>,
  "cases": [4-6 of {"name": <the requirement checked — never containing the answer>, "args": [<JSON arguments>], "expect": <the exact value the real function returns>}],
  "prose": {"context_line": <one line tying it to ${repo}>, "hint": <one nudge>, "success_line": <one line for after>}
}`;

// The Python variant: same hidden-reference trick, but the deliverable is a whole program under
// the fixed JSON harness, because that is what the exec family can judge mechanically.
const AUTHOR_PROMPT_PY = (repo: string, c: RepoCandidate) => `You are turning REAL code from the repository "${repo}" into a coding exercise.
The learner will be shown a problem statement (never this code) and must write a COMPLETE python3
program with the same observable behavior, under this fixed harness contract: stdin carries a JSON
array of arguments; the program prints json.dumps of the result with separators=(",", ":"),
sort_keys=True, ensure_ascii=False, after folding integral floats to ints (33.0 prints as 33) and
tuples to lists. The original function below stays hidden and is the reference the suite is
verified against.

# ${c.file}
${c.source}

Respond with ONLY valid JSON, no fences:
{
  "title": <short human title naming what the function does, not its name>,
  "statement": <3-6 line contract: the JSON-array-on-stdin input, each argument's meaning, the JSON
    printed on stdout, edge rules. State the harness contract explicitly. Describe BEHAVIOR you can
    observe from the code; never describe the implementation or paste any of it>,
  "cases": [4-6 of {"name": <the requirement checked — never containing the answer>, "args": [<JSON arguments>], "expect": <the exact JSON value the real function returns>}],
  "prose": {"context_line": <one line tying it to ${repo}>, "hint": <one nudge>, "success_line": <one line for after>}
}`;

export interface RepoMineDeps {
  generate: (prompt: string) => Promise<string>;
  modelName?: string;
  now?: () => Date;
}

export interface RepoMineReport {
  candidates: number;
  qualified: number;
  pending: string[];
  rejected: string[];
  /** Present when a whole language was skipped (e.g. python3 not installed) — the report must say
   *  so, or "0 candidates" from a Python repo reads as a miner fault instead of a missing runtime. */
  note?: string;
}

const MAX_QUALIFY_CHECKS = 16;
const MAX_EXERCISES = 5;

/**
 * Mine a repo into pending generated exercises. Every result goes through the standard review
 * gate: verified mechanically here, approved by the learner in the Library before it is served.
 */
export async function mineRepoBuiltin(
  vault: string, repoName: string, repoPath: string, deps: RepoMineDeps,
): Promise<RepoMineReport> {
  let all = findCandidates(repoPath);
  const report: RepoMineReport = { candidates: all.length, qualified: 0, pending: [], rejected: [] };
  if (all.some((c) => c.lang === 'py') && !(await runtimeStatus('python3')).available) {
    all = all.filter((c) => c.lang !== 'py');
    report.note = 'python3 is not installed, so .py candidates were skipped';
  }
  const seen = new Set<string>();

  for (const c of all.slice(0, MAX_QUALIFY_CHECKS)) {
    if (report.pending.length + report.rejected.length >= MAX_EXERCISES) break;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    if (!(await qualifies(c))) continue;
    report.qualified++;

    const pattern = `${repoName}-${c.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    let parsed: any;
    try {
      const raw = await deps.generate((c.lang === 'py' ? AUTHOR_PROMPT_PY : AUTHOR_PROMPT)(repoName, c));
      parsed = JSON.parse(raw.trim().replace(/^```json?\n?|```$/g, ''));
    } catch {
      // A model that fails to author one candidate should not sink the whole mining pass.
      continue;
    }
    const rawCases: any[] = Array.isArray(parsed.cases) ? parsed.cases : [];
    const ex: GeneratedExercise = {
      pattern,
      title: String(parsed.title ?? c.name),
      family: c.lang === 'py' ? 'exec' : 'function',
      ...(c.lang === 'py' ? { runtime: 'python3' } : {}),
      entryPoint: c.name,
      statement: String(parsed.statement ?? ''),
      reference: c.lang === 'py' ? pyReferenceProgram(c) : c.source,
      // Python cases are built HERE, not trusted from the model as stdout strings: stdin is our
      // own serialization of the args array, and expect is the model's JSON value printed the
      // way the harness prints — so a formatting guess can never be the reason a case fails.
      cases: c.lang === 'py'
        ? rawCases.map((k: any) => ({
          name: String(k.name ?? ''),
          stdin: JSON.stringify(Array.isArray(k.args) ? k.args : []),
          args: [],
          expect: pyJson(k.expect ?? null),
        }))
        : rawCases.map((k: any) => ({
          name: String(k.name ?? ''), args: Array.isArray(k.args) ? k.args : [], expect: k.expect ?? null,
        })),
      prose: {
        context_line: String(parsed.prose?.context_line ?? `From ${repoName}'s own code.`),
        hint: String(parsed.prose?.hint ?? ''),
        success_line: String(parsed.prose?.success_line ?? ''),
      },
      status: 'pending',
      verification: { ok: false, gates: [] },
      // The repo-miner prefix is provenance the review card renders: a MINED exercise's reference
      // is the repo's own code, and "authored by the tutor" would be the wrong claim to review it
      // under. (seedPatternPages embeds this string in page sources too — same honesty.)
      generatedBy: `repo-miner (${deps.modelName ?? 'model'})`,
      generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    };
    ex.verification = await verifyExercise(ex);
    if (!ex.verification.ok) ex.status = 'rejected';
    saveGenerated(vault, ex);
    (ex.status === 'pending' ? report.pending : report.rejected).push(pattern);
  }
  return report;
}
