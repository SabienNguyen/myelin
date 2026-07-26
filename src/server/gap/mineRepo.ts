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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runInChild } from './runner.js';
import {
  saveGenerated, verifyExercise, type GeneratedExercise,
} from './generated.js';

export interface RepoCandidate {
  name: string;
  source: string;
  /** repo-relative path, for provenance in the exercise title/statement. */
  file: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'coverage', '.next', 'target']);
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx)$/;
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
    out.push({ name: m[2], source: decl, file });
  }
  return out;
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
      if (!CODE_EXT.test(entry) || /\.(test|spec)\./.test(entry) || st.size > MAX_FILE_BYTES) continue;
      filesSeen++;
      try {
        found.push(...extractFunctions(readFileSync(full, 'utf8'), relative(repoPath, full)));
      } catch { /* unreadable file — skip */ }
    }
  };
  walk(repoPath);
  return found;
}

/** Does this extracted source, alone, evaluate and define its own name? Runs in the killable
 *  child with an empty suite — syntax errors, TS annotations, and module-scope references to
 *  anything external all fail here, mechanically. */
export async function qualifies(c: RepoCandidate): Promise<boolean> {
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
  const all = findCandidates(repoPath);
  const report: RepoMineReport = { candidates: all.length, qualified: 0, pending: [], rejected: [] };
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
      const raw = await deps.generate(AUTHOR_PROMPT(repoName, c));
      parsed = JSON.parse(raw.trim().replace(/^```json?\n?|```$/g, ''));
    } catch {
      // A model that fails to author one candidate should not sink the whole mining pass.
      continue;
    }
    const ex: GeneratedExercise = {
      pattern,
      title: String(parsed.title ?? c.name),
      family: 'function',
      entryPoint: c.name,
      statement: String(parsed.statement ?? ''),
      reference: c.source,
      cases: Array.isArray(parsed.cases) ? parsed.cases.map((k: any) => ({
        name: String(k.name ?? ''), args: Array.isArray(k.args) ? k.args : [], expect: k.expect ?? null,
      })) : [],
      prose: {
        context_line: String(parsed.prose?.context_line ?? `From ${repoName}'s own code.`),
        hint: String(parsed.prose?.hint ?? ''),
        success_line: String(parsed.prose?.success_line ?? ''),
      },
      status: 'pending',
      verification: { ok: false, gates: [] },
      generatedBy: deps.modelName ?? 'repo-miner',
      generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    };
    ex.verification = await verifyExercise(ex);
    if (!ex.verification.ok) ex.status = 'rejected';
    saveGenerated(vault, ex);
    (ex.status === 'pending' ? report.pending : report.rejected).push(pattern);
  }
  return report;
}
