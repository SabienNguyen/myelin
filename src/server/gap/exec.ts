// The exec exercise family: a whole PROGRAM under test, in whatever runtimes this machine has.
//
// This is the sandbox's generalist tier. The stream and function families execute JavaScript
// inside a node vm; this one runs the learner's program as its own process — python3, bash, ruby,
// node — feeds each suite case its stdin and argv, and compares stdout. The judge model: nothing
// about the grading knows the language, so one family covers algorithm practice, CLI tools, text
// processing and scripting in every runtime the machine can actually run.
//
// Trust model: unchanged from runner.ts, and worth restating because the blast radius grows with
// generality. This is a LOCAL personal app running the learner's own code on the learner's own
// machine — the same trust a test runner or a REPL gets. The child process is isolation against
// accidents (hangs, runaway output), enforced by wall-clock SIGKILL and an output cap; it is NOT a
// security boundary against an adversary, and no copy anywhere should claim otherwise.
//
// What this still is not: an ENVIRONMENT. One file, one process, no network services, no
// databases, no filesystem fixtures. That tier — real multi-service environments — needs
// containers, and pretending a process spawn covers it would be the kind of lie this codebase
// exists to avoid.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerResult } from './runner.js';

export interface ExecCase {
  name: string;
  stdin?: string;
  args?: string[];
  /** Exact expected stdout, compared after trailing-whitespace trim on both sides. */
  expect: string;
}

export interface Runtime {
  /** The id an exercise names, e.g. 'python3'. */
  id: string;
  /** argv[0] plus fixed flags; the program file path is appended. */
  command: string[];
  /** Program file name inside the temp dir — some runtimes care about the extension. */
  file: string;
  /** Comment prefix for scaffolds/statements in this runtime's language. */
  comment: string;
}

// node runs via process.execPath (ELECTRON_RUN_AS_NODE, same trick as runner.ts) so it exists even
// inside the packaged app where no system node is installed.
const RUNTIMES: Runtime[] = [
  { id: 'node', command: [process.execPath], file: 'main.js', comment: '//' },
  { id: 'python3', command: ['python3'], file: 'main.py', comment: '#' },
  { id: 'bash', command: ['bash'], file: 'main.sh', comment: '#' },
  { id: 'ruby', command: ['ruby'], file: 'main.rb', comment: '#' },
];

const detected = new Map<string, boolean>();

/** Is this runtime actually present? node always is (it is this process); everything else is
 *  probed once with `--version` and cached for the process lifetime. */
export async function runtimeAvailable(id: string): Promise<boolean> {
  if (id === 'node') return true;
  const rt = RUNTIMES.find((r) => r.id === id);
  if (!rt) return false;
  if (detected.has(id)) return detected.get(id)!;
  const ok = await new Promise<boolean>((resolve) => {
    const probe = spawn(rt.command[0], ['--version'], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0));
  });
  detected.set(id, ok);
  return ok;
}

export function runtimeFor(id: string): Runtime | undefined {
  return RUNTIMES.find((r) => r.id === id);
}

export async function availableRuntimes(): Promise<string[]> {
  const out: string[] = [];
  for (const rt of RUNTIMES) {
    if (await runtimeAvailable(rt.id)) out.push(rt.id);
  }
  return out;
}

const KILL_AFTER_MS = 6_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

interface ProgramRun { stdout: string; exitCode: number | null; killed: boolean; spawnError?: string }

function runOnce(rt: Runtime, programPath: string, args: string[], stdin: string): Promise<ProgramRun> {
  return new Promise((resolve) => {
    const child = spawn(rt.command[0], [...rt.command.slice(1), programPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(rt.id === 'node' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
    });
    let stdout = '';
    let killed = false;
    let settled = false;
    const finish = (r: ProgramRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(r);
    };
    const killer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, KILL_AFTER_MS);
    child.stdout.on('data', (d) => {
      stdout += d;
      // Output cap: a program printing in a loop must not buffer the server into the ground.
      if (stdout.length > MAX_OUTPUT_BYTES) { killed = true; child.kill('SIGKILL'); }
    });
    child.stderr.resume(); // drained so a chatty program can't deadlock the pipe
    child.on('error', (e) => finish({ stdout: '', exitCode: null, killed: false, spawnError: e.message }));
    child.on('close', (code) => finish({ stdout, exitCode: code, killed }));
    child.stdin.on('error', () => { /* program exited without reading stdin — fine */ });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/**
 * Run the learner's program against the suite: one process per case, stdin/args in, stdout
 * compared after trailing-whitespace trim. Returns the RunnerResult shape everything downstream
 * already renders. A nonzero exit is a failure for that case with the exit named — a program that
 * crashes on an edge case should read as exactly that.
 */
export async function runProgram(runtimeId: string, code: string, cases: ExecCase[]): Promise<RunnerResult> {
  const rt = runtimeFor(runtimeId);
  if (!rt) return { pass: false, results: [], syntaxError: `unknown runtime "${runtimeId}"` };
  if (!(await runtimeAvailable(rt.id))) {
    return { pass: false, results: [], syntaxError: `${rt.id} is not installed on this machine` };
  }
  const dir = mkdtempSync(join(tmpdir(), 'lwh-exec-'));
  const programPath = join(dir, rt.file);
  writeFileSync(programPath, code);
  try {
    const results: RunnerResult['results'] = [];
    const fired: string[] = [];
    for (const c of cases) {
      const run = await runOnce(rt, programPath, c.args ?? [], c.stdin ?? '');
      if (run.spawnError) {
        return { pass: false, results: [], syntaxError: `could not start ${rt.id}: ${run.spawnError}` };
      }
      const actualOut = run.stdout.replace(/\r\n/g, '\n').trimEnd();
      const expected = c.expect.replace(/\r\n/g, '\n').trimEnd();
      const ok = !run.killed && run.exitCode === 0 && actualOut === expected;
      const row: RunnerResult['results'][number] = { name: c.name, pass: ok };
      if (!ok) {
        row.expected = expected;
        row.actual = run.killed
          ? `ran past ${Math.round(KILL_AFTER_MS / 1000)}s (or flooded output) and was stopped`
          : run.exitCode !== 0
            ? `exited with code ${run.exitCode}${actualOut ? ` — stdout: ${actualOut.slice(0, 200)}` : ''}`
            : actualOut;
      }
      results.push(row);
      if (ok) fired.push(c.name);
    }
    return { pass: results.every((r) => r.pass), results, trace: { fired } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Scratch for programs: the learner's own stdin, their program's own stdout, nothing asserted. */
export async function scratchProgram(runtimeId: string, code: string, stdin: string): Promise<RunnerResult> {
  const rt = runtimeFor(runtimeId);
  if (!rt) return { pass: false, results: [], scratch: true, runtimeError: `unknown runtime "${runtimeId}"` };
  if (!(await runtimeAvailable(rt.id))) {
    return { pass: false, results: [], scratch: true, runtimeError: `${rt.id} is not installed on this machine` };
  }
  const dir = mkdtempSync(join(tmpdir(), 'lwh-exec-'));
  const programPath = join(dir, rt.file);
  writeFileSync(programPath, code);
  try {
    const run = await runOnce(rt, programPath, [], stdin);
    if (run.spawnError) {
      return { pass: false, results: [], scratch: true, runtimeError: `could not start ${rt.id}: ${run.spawnError}` };
    }
    if (run.killed) {
      return { pass: false, results: [], scratch: true, runtimeError: `ran past ${Math.round(KILL_AFTER_MS / 1000)}s (or flooded output) and was stopped` };
    }
    return { pass: true, results: [], scratch: true, actual: run.stdout.replace(/\r\n/g, '\n').trimEnd() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
