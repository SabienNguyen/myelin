// The built-in mining pass — "give it a repo link, learn to code in that codebase" without the
// external the-gap checkout. The load-bearing property: the repo's own function is the hidden
// reference, the model authors ONLY the suite, and the standard gates verify that suite against
// the real implementation before anything reaches the review queue.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  extractFunctions, findCandidates, mineRepoBuiltin, qualifies,
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

describe('qualification', () => {
  it('admits a self-contained function and rejects TS annotations and external references', async () => {
    expect(await qualifies({ name: 'clamp', source: CLAMP.replace(/^export /, ''), file: 'a.js' })).toBe(true);
    expect(await qualifies({
      name: 'typed', source: 'function typed(a: number): number {\n  return a + 1;\n}', file: 'a.ts',
    })).toBe(false);
    // An external reference inside the BODY qualifies (nothing has called it yet) — gate 1
    // catches it when the suite runs. The same reference exercised at module scope fails here.
    expect(await qualifies({
      name: 'needy', source: 'function needy(a) {\n  return lodashMax(a);\n}', file: 'a.js',
    })).toBe(true);
    expect(await qualifies({
      name: 'needy', source: 'function needy(a) {\n  return lodashMax(a);\n}\nneedy([1]);', file: 'a.js',
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
