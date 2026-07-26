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
// databases, no filesystem fixtures. The container runtimes below do not change that — Docker
// here buys LANGUAGES the machine lacks (go, java) with real resource caps, not multi-service
// scenarios; a containerized judge run is still one program, one stdin, one stdout. Claiming
// more would be the kind of lie this codebase exists to avoid.

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
  /** argv[0] plus fixed flags; the program file path is appended. Local runtimes only. */
  command?: string[];
  /** Container runtimes only: the image the program runs in, and the in-container command the
   *  program file path is appended to. The image is NEVER pulled implicitly — a missing image is
   *  reported with the exact `docker pull` to run, because a grading request that silently starts
   *  a multi-gigabyte download is a hang report waiting to happen. */
  image?: string;
  containerCmd?: string[];
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
  // The container tier: languages the machine itself need not have. `go run` compiles per case;
  // `java Main.java` is the single-file source launcher (Java 11+). Both are one-file judge runs —
  // multi-file projects and services stay out of scope, containers or not.
  { id: 'go', image: 'golang:1.24-alpine', containerCmd: ['go', 'run'], file: 'main.go', comment: '//' },
  { id: 'java', image: 'eclipse-temurin:21', containerCmd: ['java'], file: 'Main.java', comment: '//' },
];

export const isContainerRuntime = (rt: Runtime): boolean => rt.image !== undefined;

export interface RuntimeStatus {
  id: string;
  available: boolean;
  /** When unavailable: what is missing and — where actionable — the exact command that fixes it. */
  reason?: string;
}

const statusCache = new Map<string, RuntimeStatus>();

/** Probe one command; true iff it spawns and exits 0. */
function probeOk(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(cmd, args, { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Availability with the REASON attached, because "go is not available" has three different fixes
 * (install docker / start the daemon / pull the image) and the learner deserves to be told which.
 * Cached per process lifetime, except the daemon-down and image-missing cases — those are exactly
 * the states a user fixes mid-session, so re-probing them is the point.
 */
export async function runtimeStatus(id: string): Promise<RuntimeStatus> {
  const rt = RUNTIMES.find((r) => r.id === id);
  if (!rt) return { id, available: false, reason: `unknown runtime "${id}"` };
  if (id === 'node') return { id, available: true };
  const cached = statusCache.get(id);
  if (cached) return cached;

  let status: RuntimeStatus;
  let cacheable = true;
  if (!isContainerRuntime(rt)) {
    const ok = await probeOk(rt.command![0], ['--version']);
    status = ok ? { id, available: true }
      : { id, available: false, reason: `${id} is not installed on this machine` };
  } else if (!(await probeOk('docker', ['--version']))) {
    status = { id, available: false, reason: `${id} runs in a container, and Docker is not installed` };
  } else if (!(await probeOk('docker', ['info']))) {
    status = { id, available: false, reason: `${id} runs in a container, and the Docker daemon is not running — start Docker and try again` };
    cacheable = false;
  } else if (!(await probeOk('docker', ['image', 'inspect', rt.image!]))) {
    status = { id, available: false, reason: `the ${rt.image} image is not present — run: docker pull ${rt.image}` };
    cacheable = false;
  } else {
    status = { id, available: true };
  }
  if (cacheable) statusCache.set(id, status);
  return status;
}

export async function runtimeAvailable(id: string): Promise<boolean> {
  return (await runtimeStatus(id)).available;
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

/** Every runtime with its status — the /api/gap/environments payload, reasons included. */
export async function runtimeStatuses(): Promise<RuntimeStatus[]> {
  return Promise.all(RUNTIMES.map((rt) => runtimeStatus(rt.id)));
}

/**
 * The docker argv for one containerized case run — pure, so the sandboxing flags are pinned by a
 * unit test rather than trusted. The temp dir mounts READ-ONLY at /work; no network; memory, cpu
 * and pid caps bound the blast radius of a hostile-by-accident program.
 */
export function dockerArgs(rt: Runtime, dir: string, args: string[]): string[] {
  return [
    'run', '--rm', '-i',
    '--network', 'none',
    '--memory', '512m',
    '--cpus', '1',
    '--pids-limit', '128',
    '-v', `${dir}:/work:ro`,
    '-w', '/work',
    rt.image!,
    ...rt.containerCmd!,
    `/work/${rt.file}`,
    ...args,
  ];
}

const KILL_AFTER_MS = 6_000;
// Container cases get longer: `go run` compiles per case, and a cold container start adds real
// seconds that have nothing to do with the learner's program.
const CONTAINER_KILL_AFTER_MS = 30_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

interface ProgramRun { stdout: string; exitCode: number | null; killed: boolean; spawnError?: string }

/** The full argv for one case run, local or containerized. */
function argvFor(rt: Runtime, dir: string, args: string[]): string[] {
  return isContainerRuntime(rt)
    ? ['docker', ...dockerArgs(rt, dir, args)]
    : [...rt.command!, join(dir, rt.file), ...args];
}

const killAfterFor = (rt: Runtime) => (isContainerRuntime(rt) ? CONTAINER_KILL_AFTER_MS : KILL_AFTER_MS);

function runOnce(rt: Runtime, dir: string, args: string[], stdin: string): Promise<ProgramRun> {
  const argv = argvFor(rt, dir, args);
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
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
    const killer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, killAfterFor(rt));
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
  const status = await runtimeStatus(runtimeId);
  if (!status.available) {
    return { pass: false, results: [], syntaxError: status.reason ?? `${rt.id} is not available` };
  }
  const dir = mkdtempSync(join(tmpdir(), 'lwh-exec-'));
  writeFileSync(join(dir, rt.file), code);
  try {
    const results: RunnerResult['results'] = [];
    const fired: string[] = [];
    for (const c of cases) {
      const run = await runOnce(rt, dir, c.args ?? [], c.stdin ?? '');
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
          ? `ran past ${Math.round(killAfterFor(rt) / 1000)}s (or flooded output) and was stopped`
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
  const status = await runtimeStatus(runtimeId);
  if (!status.available) {
    return { pass: false, results: [], scratch: true, runtimeError: status.reason ?? `${rt.id} is not available` };
  }
  const dir = mkdtempSync(join(tmpdir(), 'lwh-exec-'));
  writeFileSync(join(dir, rt.file), code);
  try {
    const run = await runOnce(rt, dir, [], stdin);
    if (run.spawnError) {
      return { pass: false, results: [], scratch: true, runtimeError: `could not start ${rt.id}: ${run.spawnError}` };
    }
    if (run.killed) {
      return { pass: false, results: [], scratch: true, runtimeError: `ran past ${Math.round(killAfterFor(rt) / 1000)}s (or flooded output) and was stopped` };
    }
    return { pass: true, results: [], scratch: true, actual: run.stdout.replace(/\r\n/g, '\n').trimEnd() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
