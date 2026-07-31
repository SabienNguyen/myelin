// The built-in mining pass — "give it a repo link, learn to code in that codebase" without the
// external the-gap checkout. The load-bearing property: the repo's own function is the hidden
// reference, the model authors ONLY the suite, and the standard gates verify that suite against
// the real implementation before anything reaches the review queue.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';

// ingestRepo's external-vs-builtin decision probes THE_GAP_ROOT once, at module load. Without
// this pin the fallback test below is environment-dependent: green on CI (no checkout) but red
// on any machine with a real ~/Dev/personal/the-gap, where the probe routes to the external
// miner and the injected builtinMiner never runs. vi.hoisted executes before the import above.
vi.hoisted(() => { process.env.THE_GAP_REPO = '/nonexistent-the-gap'; });
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  extractFunctions, extractPythonFunctions, findCandidates, mineRepoBuiltin, pyJson, qualifies,
} from '../src/server/gap/mineRepo.js';
import { listGenerated } from '../src/server/gap/generated.js';
import { ingestRepo } from '../src/server/ingestRepo.js';
import { readQueue } from '../src/server/queueStore.js';

let vault: string;
let repo: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'lwh-mine-vault-'));
  repo = mkdtempSync(join(tmpdir(), 'lwh-mine-repo-'));
});

const CLAMP = `export function clamp(value, lo, hi) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}`;

describe('candidate extraction', () => {
  it('extracts top-level named functions with balanced bodies, stripping export', () => {
    const found = extractFunctions(`${CLAMP}\n\nconst x = 1;\nasync function fetchIt(url) {\n  const r = await fetch(url);\n  return r.json();\n}\n`, 'src/util.js');
    expect(found.map((c) => c.name)).toEqual(['clamp', 'fetchIt']);
    expect(found[0].source.startsWith('function clamp')).toBe(true);
  });

  it('skips generators and one-liners', () => {
    const found = extractFunctions('function* gen() {\n  yield 1;\n  yield 2;\n}\nfunction tiny() { return 1; }\n', 'a.js');
    expect(found).toEqual([]);
  });

  it('walks a repo, skipping node_modules and tests', () => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(repo, 'src', 'util.js'), CLAMP);
    writeFileSync(join(repo, 'src', 'util.test.js'), 'function inTest(a, b) {\n  return a + b;\n}\n');
    writeFileSync(join(repo, 'node_modules', 'x', 'dep.js'), 'function inDep(a) {\n  return a;\n}\n');
    expect(findCandidates(repo).map((c) => c.name)).toEqual(['clamp']);
  });
});

const PY_TAX = `def tax_total(amounts, rate):
    total = 0
    for a in amounts:
        total += a
    return round(total * (1 + rate), 2)
`;

describe('python candidate extraction', () => {
  it('extracts column-0 defs, delimited by indentation', () => {
    const text = `import math\n\n${PY_TAX}\nX = 1\n`;
    const found = extractPythonFunctions(text, 'src/money.py');
    expect(found.map((c) => c.name)).toEqual(['tax_total']);
    expect(found[0].lang).toBe('py');
    expect(found[0].source.trim().endsWith('return round(total * (1 + rate), 2)')).toBe(true);
  });

  it('skips methods, decorated defs, _private names, generators, and one-liners', () => {
    const text = [
      'class C:',
      '    def method(self):',        // indented — not column 0
      '        return 1',
      '@lru_cache',
      'def decorated(a):',            // decorator changes behavior and is not extracted
      '    return a',
      '    # pad',
      'def _private(a):',
      '    return a',
      '    # pad',
      'def gen(n):',
      '    for i in range(n):',
      '        yield i',
      'def tiny(): return 1',
    ].join('\n');
    expect(extractPythonFunctions(text, 'a.py')).toEqual([]);
  });

  it('walks .py files too, skipping test_ files', () => {
    writeFileSync(join(repo, 'money.py'), PY_TAX);
    writeFileSync(join(repo, 'test_money.py'), 'def helper_in_test(a):\n    b = a + 1\n    return b\n');
    expect(findCandidates(repo).map((c) => `${c.lang}:${c.name}`)).toEqual(['py:tax_total']);
  });
});

describe('python qualification and harness', () => {
  it('admits a self-contained def and rejects a module-scope external reference', async () => {
    expect(await qualifies({ name: 'tax_total', source: PY_TAX, file: 'a.py', lang: 'py' })).toBe(true);
    expect(await qualifies({
      name: 'needy', source: 'def needy(a):\n    return a\n\nneedy(missing_global)', file: 'a.py', lang: 'py',
    })).toBe(false);
  });

  it('pyJson matches the harness byte-for-byte, keys sorted, compact', async () => {
    // The load-bearing agreement: what pyJson prints in JS is exactly what json.dumps prints in
    // the reference harness — otherwise every mined case would fail on formatting, not behavior.
    const { runProgram } = await import('../src/server/gap/exec.js');
    const value = { b: [1, 2], a: 'é' };
    const prog = `import json\nprint(json.dumps({"b": [1, 2], "a": "é"}, separators=(",", ":"), sort_keys=True, ensure_ascii=False))`;
    const run = await runProgram('python3', prog, [{ name: 'agrees', stdin: '', args: [], expect: pyJson(value) }]);
    expect(run.pass).toBe(true);
  });
});

describe('qualification', () => {
  it('admits a self-contained function and rejects TS annotations and external references', async () => {
    expect(await qualifies({ name: 'clamp', source: CLAMP.replace(/^export /, ''), file: 'a.js', lang: 'js' as const })).toBe(true);
    expect(await qualifies({
      name: 'typed', source: 'function typed(a: number): number {\n  return a + 1;\n}', file: 'a.ts', lang: 'js' as const,
    })).toBe(false);
    // An external reference inside the BODY qualifies (nothing has called it yet) — gate 1
    // catches it when the suite runs. The same reference exercised at module scope fails here.
    expect(await qualifies({
      name: 'needy', source: 'function needy(a) {\n  return lodashMax(a);\n}', file: 'a.js', lang: 'js' as const,
    })).toBe(true);
    expect(await qualifies({
      name: 'needy', source: 'function needy(a) {\n  return lodashMax(a);\n}\nneedy([1]);', file: 'a.js', lang: 'js' as const,
    })).toBe(false);
  });
});

describe('mineRepoBuiltin', () => {
  const goodSuite = {
    title: 'Clamp a value to a range',
    statement: 'Given a value and inclusive bounds lo and hi, return the value limited to [lo, hi].',
    cases: [
      { name: 'inside the range passes through', args: [5, 0, 10], expect: 5 },
      { name: 'below the range', args: [-3, 0, 10], expect: 0 },
      { name: 'above the range', args: [42, 0, 10], expect: 10 },
      { name: 'at the boundary', args: [10, 0, 10], expect: 10 },
    ],
    prose: { context_line: 'From the repo.', hint: 'Two comparisons.', success_line: 'Done.' },
  };

  it('authors a pending exercise whose reference is the REPO function, verified by the gates', async () => {
    writeFileSync(join(repo, 'util.js'), CLAMP);
    const report = await mineRepoBuiltin(vault, 'myrepo', repo, { generate: async () => JSON.stringify(goodSuite) });
    expect(report.pending).toEqual(['myrepo-clamp']);
    const [ex] = listGenerated(vault);
    expect(ex.status).toBe('pending');
    expect(ex.family).toBe('function');
    expect(ex.reference).toContain('function clamp');
    expect(ex.verification.ok).toBe(true);
  });

  it('a suite the real function cannot pass is auto-rejected — the model cannot misdescribe the code', async () => {
    writeFileSync(join(repo, 'util.js'), CLAMP);
    const wrong = {
      ...goodSuite,
      cases: goodSuite.cases.map((c, i) => (i === 0 ? { ...c, expect: 999 } : c)),
    };
    const report = await mineRepoBuiltin(vault, 'myrepo', repo, { generate: async () => JSON.stringify(wrong) });
    expect(report.pending).toEqual([]);
    expect(report.rejected).toEqual(['myrepo-clamp']);
    const [ex] = listGenerated(vault);
    expect(ex.verification.gates.find((g) => g.gate === 'reference-passes')?.ok).toBe(false);
  });

  it('mines a python repo into a pending exec exercise whose reference is the repo def + harness', async () => {
    writeFileSync(join(repo, 'money.py'), PY_TAX);
    const pySuite = {
      title: 'Total with tax',
      statement: 'stdin: a JSON array [amounts, rate]. Print the summed amounts times (1+rate), rounded to 2 places, as compact JSON.',
      cases: [
        { name: 'two items', args: [[10, 20], 0.1], expect: 33.0 },
        { name: 'empty list', args: [[], 0.2], expect: 0 },
        { name: 'zero rate', args: [[5], 0], expect: 5 },
        { name: 'rounding', args: [[0.1, 0.2], 0.5], expect: 0.45 },
      ],
      prose: { context_line: 'From the repo.', hint: 'Sum first.', success_line: 'Done.' },
    };
    const report = await mineRepoBuiltin(vault, 'pyrepo', repo, { generate: async () => JSON.stringify(pySuite) });
    expect(report.pending).toEqual(['pyrepo-tax-total']);
    const [ex] = listGenerated(vault);
    expect(ex.family).toBe('exec');
    expect(ex.runtime).toBe('python3');
    expect(ex.reference.startsWith('def tax_total')).toBe(true);
    expect(ex.reference).toContain('print(json.dumps(_n(tax_total(*_args))');
    expect(ex.verification.ok).toBe(true);
    // Cases were rebuilt server-side: stdin is our serialization of args, expect is pyJson'd.
    expect((ex.cases[0] as any).stdin).toBe('[[10,20],0.1]');
    // Mined provenance travels: the review card keys "mined from your repo" copy off this prefix.
    expect(ex.generatedBy.startsWith('repo-miner (')).toBe(true);
  });

  it('a model that returns garbage for one candidate does not sink the pass', async () => {
    writeFileSync(join(repo, 'util.js'), CLAMP);
    const report = await mineRepoBuiltin(vault, 'myrepo', repo, { generate: async () => 'not json' });
    expect(report.pending).toEqual([]);
    expect(report.rejected).toEqual([]);
    expect(report.qualified).toBe(1);
  });
});

describe('ingestRepo builtin fallback', () => {
  it('with no external miner available, the built-in pass runs and the ingest finishes done', async () => {
    writeFileSync(join(repo, 'util.js'), CLAMP);
    const lw = { listSlugs: async () => [], call: async () => ({}) } as any;
    const cfg = { vault, autoCompile: false, models: { compile: { model: 'x' } } } as any;
    let builtinCalls = 0;
    ingestRepo(lw, cfg, repo, {
      builtinMiner: async (rn, rp) => {
        builtinCalls++;
        expect(rn).toBe(basename(repo));
        expect(rp).toBe(repo);
        return { candidates: 3, qualified: 1, pending: ['x-clamp'], rejected: [] };
      },
    });
    await new Promise((r) => { setTimeout(r, 300); });
    expect(builtinCalls).toBe(1);
    const entry = readQueue(vault).find((e) => e.mode === 'repo');
    expect(entry?.status).toBe('done');
    expect(entry?.phase).toContain('waiting for your approval');
  });
});
