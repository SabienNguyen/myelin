// Executes learner code for the built-in sandbox — in a CHILD PROCESS, never in this one.
//
// The stand-in this service grew out of ran submissions in-process with node:vm plus a
// Promise.race timeout, and that combination has a hole you can drive a truck through: vm's
// `timeout` covers only the synchronous top-level evaluation, and a `while (true) {}` inside the
// learner's async generator blocks the event loop — which means the race's own timer never fires.
// One busy loop in submitted code and the whole tutor (chat, grading, vault, everything sharing
// this process) stops. Adequate for a dev loop; not something to ship.
//
// A child process closes the hole from the outside: the parent arms a wall-clock timer and
// SIGKILLs the child when it fires. Nothing the child's event loop is doing can prevent that.
//
// Trust model, stated plainly: this is a LOCAL personal app running the learner's own code on the
// learner's own machine — the same trust a test runner or a REPL gets. The child is isolation
// against accidents (hangs, runaway allocation crashing the server), not a security boundary
// against an adversary. The vm context inside the child exposes only the typed-array/decoding
// globals the exercises need; there is no `require`, no `process`, no filesystem in scope.

import { spawn } from 'node:child_process';
import type { SuiteCase } from './streamConsumer.js';

/** Wall-clock ceiling for one child run. Generous next to the per-case 2s async guard inside the
 *  child, because this one is the backstop that actually kills busy loops. */
const KILL_AFTER_MS = 6_000;

export interface RunnerCaseResult { name: string; pass: boolean; expected?: string; actual?: string }
export interface RunnerResult {
  pass: boolean;
  results: RunnerCaseResult[];
  // The Pinned Contract's "the run could not be graded, and here is why" field. The name is looser
  // than its uses (the sidecar always put missing-entry-point and timeout messages here too) and it
  // is kept because the client already renders it in the right place.
  syntaxError?: string;
  trace?: { fired: string[] };
  scratch?: boolean;
  stressed?: boolean;
  actual?: string;
  chunks?: number;
  runtimeError?: string;
}

/** A function-family test case: plain values in, one value out. JSON-safe by construction — cases
 *  cross the child-process boundary as JSON, so `undefined` can never be an EXPECTED value (an
 *  implementation that returns undefined is exactly what the comparison must reject). */
export interface FnCase { name: string; args: unknown[]; expect: unknown }

/** `family` picks the calling convention: 'stream' (the default, and the only one that existed
 *  before generated exercises went any-domain) drives an async generator over hostile byte chunks;
 *  'function' calls `entryPoint(...args)` and deep-compares the (awaited) return value. */
export type RunnerJob =
  | { kind: 'suite'; family?: 'stream'; code: string; entryPoint: string; cases: SuiteCase[] }
  | { kind: 'suite'; family: 'function'; code: string; entryPoint: string; cases: FnCase[] }
  | { kind: 'scratch'; family?: 'stream'; code: string; entryPoint: string; input: string }
  | { kind: 'scratch'; family: 'function'; code: string; entryPoint: string; input: string };

/**
 * The program the child runs, passed via `-e`. Self-contained on purpose: a separate script file
 * would be one more asset to carry through tsc, asar packing and the AppImage — a string constant
 * cannot be left behind by a build step.
 *
 * Protocol: job JSON on stdin, ONE result JSON line on stdout. The sandbox's `console` writes to
 * stderr so learner logging can never corrupt the protocol.
 */
const CHILD_SOURCE = `
const vm = require('node:vm');
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', async () => {
  const done = (out) => { process.stdout.write(JSON.stringify(out) + '\\n'); process.exit(0); };
  let job;
  try { job = JSON.parse(raw); } catch { return done({ pass: false, results: [], syntaxError: 'runner protocol error: bad job JSON' }); }

  const sandboxConsole = {
    log: (...a) => process.stderr.write(a.join(' ') + '\\n'),
    error: (...a) => process.stderr.write(a.join(' ') + '\\n'),
    warn: (...a) => process.stderr.write(a.join(' ') + '\\n'),
  };
  let fn;
  try {
    fn = vm.runInNewContext(job.code + '\\n;' + job.entryPoint, {
      TextDecoder, TextEncoder, DataView, Uint8Array, console: sandboxConsole,
    }, { timeout: 2000 });
  } catch (e) {
    return done({ pass: false, results: [], syntaxError: e instanceof Error ? e.message : String(e) });
  }
  if (typeof fn !== 'function') {
    return done({ pass: false, results: [], syntaxError: 'no function named ' + job.entryPoint + ' was defined' });
  }

  async function* iterate(chunks) { for (const c of chunks) yield Uint8Array.from(c); }
  const raceCollect = async (chunks) => {
    const out = [];
    const collect = (async () => { for await (const v of fn(iterate(chunks))) out.push(v); })();
    // Guards async stalls (an awaited promise that never resolves). A synchronous busy loop blocks
    // this whole process instead — which is fine, because the PARENT kills us on wall clock.
    await Promise.race([collect, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
    return out;
  };
  // ser, not JSON.stringify directly: stringify(undefined) is undefined-the-value, and undefined is
  // precisely what a do-nothing implementation returns — it must compare UNEQUAL to every JSON
  // expectation, not disappear into one.
  const ser = (v) => JSON.stringify(v === undefined ? '\\u0000undefined' : v);
  const raceCall = async (args) => {
    const result = Promise.resolve(fn(...args));
    return Promise.race([result, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
  };

  if (job.family === 'function') {
    if (job.kind === 'scratch') {
      let args;
      try {
        args = JSON.parse(String(job.input ?? ''));
      } catch {
        return done({ pass: false, results: [], scratch: true, runtimeError: 'write the arguments as a JSON array, e.g. [3, "abc"]' });
      }
      if (!Array.isArray(args)) args = [args];
      try {
        const out = await raceCall(args);
        return done({ pass: true, results: [], scratch: true, actual: ser(out) });
      } catch (e) {
        return done({ pass: false, results: [], scratch: true, runtimeError: e instanceof Error ? e.message : String(e) });
      }
    }
    const results = [];
    const fired = [];
    for (const c of job.cases) {
      let ok = false; let threw = null; let out;
      try {
        out = await raceCall(c.args);
        ok = ser(out) === ser(c.expect);
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      const row = { name: c.name, pass: ok };
      if (!ok) {
        row.expected = ser(c.expect);
        row.actual = threw ? 'threw: ' + threw : ser(out);
      }
      results.push(row);
      if (ok) fired.push(c.name);
    }
    return done({ pass: results.every((r) => r.pass), results, trace: { fired } });
  }

  if (job.kind === 'scratch') {
    const bytes = [...new TextEncoder().encode(String(job.input ?? ''))];
    // Deliberately awkward 7-byte slices: a scratch run that chunked on line boundaries would
    // quietly pass the very implementations the suite exists to catch.
    const slices = [];
    for (let i = 0; i < bytes.length; i += 7) slices.push(bytes.slice(i, i + 7));
    try {
      const out = await raceCollect(slices);
      return done({ pass: true, results: [], scratch: true, actual: JSON.stringify(out), chunks: slices.length });
    } catch (e) {
      return done({ pass: false, results: [], scratch: true, runtimeError: e instanceof Error ? e.message : String(e) });
    }
  }

  const results = [];
  const fired = [];
  for (const c of job.cases) {
    let ok = false; let threw = null; let out = [];
    try {
      out = await raceCollect(c.chunks);
      ok = JSON.stringify(out) === JSON.stringify(c.expect);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    // expected/actual ship ONLY for a failing case — the client puts them behind a deliberate
    // reveal that caps the run's evidence, so there is no reason to send the answer for a case
    // the learner already passed.
    const row = { name: c.name, pass: ok };
    if (!ok) {
      row.expected = JSON.stringify(c.expect);
      row.actual = threw ? 'threw: ' + threw : JSON.stringify(out);
    }
    results.push(row);
    if (ok) fired.push(c.name);
  }
  done({ pass: results.every((r) => r.pass), results, trace: { fired } });
});
`;

export function runInChild(job: RunnerJob, killAfterMs = KILL_AFTER_MS): Promise<RunnerResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD_SOURCE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Inside the packaged desktop app, process.execPath is the Electron binary; without this it
        // opens a second app window instead of running as Node. A no-op under a real node binary —
        // the same trick, for the same reason, as the Loreweaver spawn in mcp.ts.
        ELECTRON_RUN_AS_NODE: '1',
      },
    });

    let stdout = '';
    let settled = false;
    const finish = (result: RunnerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(result);
    };

    // The backstop that makes this a production runner: nothing the child's event loop is doing —
    // including a synchronous `while (true)` — survives a SIGKILL from outside it.
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        pass: false,
        results: [],
        syntaxError: `your code ran for more than ${Math.round(killAfterMs / 1000)}s without finishing — an unbounded loop somewhere?`,
      });
    }, killAfterMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.resume(); // learner console output — drained so a chatty submission cannot fill the pipe and deadlock
    child.on('error', (e) => finish({ pass: false, results: [], syntaxError: `runner failed to start: ${e.message}` }));
    child.on('close', () => {
      const line = stdout.trim().split('\n').pop() ?? '';
      try {
        finish(JSON.parse(line) as RunnerResult);
      } catch {
        finish({ pass: false, results: [], syntaxError: 'the runner crashed before producing a result' });
      }
    });

    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  });
}
