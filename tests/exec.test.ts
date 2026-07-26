// The exec family — a whole program under test in whatever runtimes the machine has. The judge
// model: stdin/argv in, exact stdout out, one process per case, wall-clock killed. These tests
// use the node runtime (guaranteed present — it is this process) plus python3 where installed.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  availableRuntimes, runProgram, runtimeAvailable, scratchProgram, type ExecCase,
} from '../src/server/gap/exec.js';
import { generateExercise, setGeneratedStatus, verifyExercise } from '../src/server/gap/generated.js';
import { buildBuiltinGapRoutes, builtinPatterns } from '../src/server/gap/service.js';

const SUM_JS = `const lines = require('node:fs').readFileSync(0, 'utf8').trim().split('\\n');
console.log(lines.map(Number).reduce((a, b) => a + b, 0));`;

const CASES: ExecCase[] = [
  { name: 'sums two numbers', stdin: '1\n2\n', expect: '3' },
  { name: 'sums many numbers', stdin: '5\n10\n15\n', expect: '30' },
  { name: 'handles a single number', stdin: '42\n', expect: '42' },
  { name: 'handles negatives', stdin: '-3\n5\n', expect: '2' },
];

describe('runProgram (node runtime)', () => {
  it('passes a correct program on all cases', async () => {
    const out = await runProgram('node', SUM_JS, CASES);
    expect(out.pass).toBe(true);
    expect(out.results).toHaveLength(4);
  });

  it('fails the right case with expected/actual only on the miss', async () => {
    const off = SUM_JS.replace('reduce((a, b) => a + b, 0)', 'reduce((a, b) => a + b, 1)');
    const out = await runProgram('node', off, CASES);
    expect(out.pass).toBe(false);
    const miss = out.results.find((r) => !r.pass)!;
    expect(miss.expected).toBeDefined();
    expect(out.results.filter((r) => r.pass).every((r) => r.expected === undefined)).toBe(true);
  });

  it('a crashing program reports its exit code', async () => {
    const out = await runProgram('node', 'process.exit(3);', CASES.slice(0, 1));
    expect(out.pass).toBe(false);
    expect(out.results[0].actual).toContain('exited with code 3');
  });

  it('an unbounded loop is killed on wall clock, not waited on', async () => {
    const out = await runProgram('node', 'for(;;){}', CASES.slice(0, 1));
    expect(out.pass).toBe(false);
    expect(out.results[0].actual).toContain('was stopped');
  }, 15_000);

  it('argv reaches the program', async () => {
    const out = await runProgram('node', 'console.log(process.argv.slice(2).join("-"));', [
      { name: 'joins argv', args: ['a', 'b'], expect: 'a-b' },
    ]);
    expect(out.pass).toBe(true);
  });

  it('scratch runs my stdin and returns stdout, asserting nothing', async () => {
    const out = await scratchProgram('node', SUM_JS, '7\n8\n');
    expect(out.scratch).toBe(true);
    expect(out.actual).toBe('15');
  });

  it('an unknown runtime is a loud error', async () => {
    const out = await runProgram('cobol', SUM_JS, CASES);
    expect(out.syntaxError).toContain('unknown runtime');
  });
});

describe('runtime detection', () => {
  it('node is always available; the list always contains it', async () => {
    expect(await runtimeAvailable('node')).toBe(true);
    expect(await availableRuntimes()).toContain('node');
  });
});

describe('exec verification gates', () => {
  const EXERCISE = {
    entryPoint: 'main',
    statement: 'Read integers, one per line, from stdin. Print their sum.',
    reference: SUM_JS,
    cases: CASES,
    family: 'exec' as const,
    runtime: 'node',
  };

  it('admits a real program exercise', async () => {
    const report = await verifyExercise(EXERCISE);
    expect(report.ok).toBe(true);
  });

  it('REJECTS a suite whose every case expects empty output — an empty program would pass it', async () => {
    const vacuous = {
      ...EXERCISE,
      reference: '',
      cases: [
        { name: 'a', stdin: 'x', expect: '' }, { name: 'b', stdin: 'y', expect: '' },
        { name: 'c', stdin: 'z', expect: '' },
      ],
    };
    const report = await verifyExercise(vacuous);
    expect(report.ok).toBe(false);
    expect(report.gates.find((g) => g.gate === 'rejects-empty-implementation')?.ok).toBe(false);
  });

  it('rejects a reference that fails its own suite', async () => {
    const broken = { ...EXERCISE, reference: 'console.log("nope");' };
    const report = await verifyExercise(broken);
    expect(report.gates.find((g) => g.gate === 'reference-passes')?.ok).toBe(false);
  });

  it('rejects a case name that contains its answer', async () => {
    const leaky = {
      ...EXERCISE,
      cases: CASES.map((c, i) => (i === 1 ? { ...c, name: 'prints 30 for many numbers' } : c)),
    };
    const report = await verifyExercise(leaky);
    expect(report.gates.find((g) => g.gate === 'names-do-not-leak-answers')?.ok).toBe(false);
  });
});

describe('exec exercises through the service', () => {
  let vault: string;
  beforeEach(() => { vault = mkdtempSync(join(tmpdir(), 'lwh-exec-svc-')); });

  const stub = async () => JSON.stringify({
    title: 'Sum the numbers',
    statement: 'Read integers, one per line, from stdin. Print their sum.',
    reference: SUM_JS,
    cases: CASES,
    prose: { context_line: 'Judge-style.', hint: 'Read all of stdin first.', success_line: 'Done.' },
  });

  it('generate -> approve -> ladder/run/scratch, exec family end to end', async () => {
    await generateExercise(vault, 'sum-stdin', 'algorithms', { generate: stub }, 'exec', 'node');
    setGeneratedStatus(vault, 'sum-stdin', 'approved');
    expect(builtinPatterns(vault)).toContain('sum-stdin');

    const app = buildBuiltinGapRoutes({ vault });
    const ladder = await (await app.request('/api/gap/ladder?pattern=sum-stdin')).json();
    expect(ladder.family).toBe('exec');
    expect(ladder.rungs[0].reference_answer).toBe('');
    expect(ladder.rungs[0].predict[0].inputPreview).toContain('stdin:');

    const run = await (await app.request('/api/gap/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'sum-stdin:full_body', code: SUM_JS }),
    })).json();
    expect(run.pass).toBe(true);

    const predict = await (await app.request('/api/gap/predict', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'sum-stdin:full_body', caseName: 'sums two numbers', prediction: ['3'] }),
    })).json();
    expect(predict.pass).toBe(true);

    const scratch = await (await app.request('/api/gap/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'sum-stdin:full_body', code: SUM_JS, input: '100\n1\n' }),
    })).json();
    expect(scratch.scratch).toBe(true);
    expect(scratch.actual).toBe('101');
  });

  it('generation for an uninstalled runtime fails loudly, storing nothing', async () => {
    await expect(generateExercise(vault, 'x', '', { generate: stub }, 'exec', 'cobol'))
      .rejects.toThrow(/unknown runtime/);
  });

  it('the environments route names what this machine can run', async () => {
    const app = buildBuiltinGapRoutes({ vault });
    const body = await (await app.request('/api/gap/environments')).json();
    expect(body.runtimes).toContain('node');
  });
});

// python3 coverage runs only where python3 exists (CI containers have it; a bare laptop may not).
describe('python3 runtime (when installed)', () => {
  it('runs a python program against the same judge', async () => {
    if (!(await runtimeAvailable('python3'))) return; // absent -> vacuously fine, the gate is availability itself
    const py = 'import sys\nprint(sum(int(l) for l in sys.stdin if l.strip()))';
    const out = await runProgram('python3', py, CASES);
    expect(out.pass).toBe(true);
  });
});

// ── the container tier: go/java via Docker ──────────────────────────────────────────────────────
//
// This dev environment has the docker CLI but no reachable daemon, which makes the FAILURE paths —
// the ones a learner actually hits — the naturally testable ones here. The happy path (a real
// containerized go run) needs a machine with a live daemon; the argv builder below is pure and
// pins the sandboxing flags so that path is at least specified, not improvised.

import { dockerArgs, runtimeFor, runtimeStatus } from '../src/server/gap/exec.js';

describe('container runtimes', () => {
  it('dockerArgs pins the sandbox flags: no network, capped memory/pids, read-only mount', () => {
    const go = runtimeFor('go')!;
    const args = dockerArgs(go, '/tmp/xyz', ['a', 'b']);
    expect(args).toEqual([
      'run', '--rm', '-i',
      '--network', 'none',
      '--memory', '512m',
      '--cpus', '1',
      '--pids-limit', '128',
      '-v', '/tmp/xyz:/work:ro',
      '-w', '/work',
      'golang:1.24-alpine',
      'go', 'run', '/work/main.go',
      'a', 'b',
    ]);
  });

  it('an unavailable container runtime says WHY, with the fix where there is one', async () => {
    const status = await runtimeStatus('go');
    if (status.available) return; // a machine with live Docker + image: nothing to assert here
    expect(status.reason).toMatch(/Docker is not installed|daemon is not running|docker pull/);
  });

  it('runProgram surfaces the container status reason instead of a generic error', async () => {
    const status = await runtimeStatus('java');
    if (status.available) return;
    const out = await runProgram('java', 'class Main { public static void main(String[] a) {} }', [
      { name: 'x', stdin: '', expect: '' },
    ]);
    expect(out.syntaxError).toBe(status.reason);
  });

  it('go and java carry their language comment prefix for scaffolds', () => {
    expect(runtimeFor('go')?.comment).toBe('//');
    expect(runtimeFor('java')?.comment).toBe('//');
    expect(runtimeFor('java')?.file).toBe('Main.java'); // the single-file source launcher cares
  });
});

// ── typescript, c, rust: the local compile tier ─────────────────────────────────────────────────

describe('typescript runtime (node type stripping)', () => {
  it('runs an annotated TS program against the same judge', async () => {
    const ts = `const lines: string[] = require('node:fs').readFileSync(0, 'utf8').trim().split('\\n');
const total: number = lines.map(Number).reduce((a: number, b: number) => a + b, 0);
console.log(total);`;
    const out = await runProgram('typescript', ts, CASES);
    expect(out.pass).toBe(true);
  });
});

describe('c runtime (when cc is installed)', () => {
  it('compiles once and passes the suite', async () => {
    if (!(await runtimeAvailable('c'))) return;
    const cSrc = `#include <stdio.h>
int main(void) {
  long total = 0, n;
  while (scanf("%ld", &n) == 1) total += n;
  printf("%ld\\n", total);
  return 0;
}`;
    const out = await runProgram('c', cSrc, CASES);
    expect(out.pass).toBe(true);
  });

  it('a compile error lands in syntaxError with the compiler message', async () => {
    if (!(await runtimeAvailable('c'))) return;
    const out = await runProgram('c', 'int main(void) { this does not compile }', CASES.slice(0, 1));
    expect(out.pass).toBe(false);
    expect(out.syntaxError).toBeDefined();
    expect(out.results).toHaveLength(0); // nothing ran — there was no binary to run
  });
});

describe('rust runtime (when rustc is installed)', () => {
  it('compiles once and passes the suite', async () => {
    if (!(await runtimeAvailable('rust'))) return;
    const rs = `use std::io::Read;
fn main() {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap();
    let total: i64 = s.split_whitespace().map(|w| w.parse::<i64>().unwrap()).sum();
    println!("{}", total);
}`;
    const out = await runProgram('rust', rs, CASES);
    expect(out.pass).toBe(true);
  }, 60_000);
});
