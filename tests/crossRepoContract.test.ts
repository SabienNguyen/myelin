// The harness MIRRORS engram's mastery contract (src/shared/engram.ts) rather than
// importing it — they are separate packages. A mirror rots silently: if engram ever tunes a
// decay window or reorders a level, the harness would keep grading, scheduling digests, and
// drawing due-badges against the OLD numbers, and nothing anywhere would fail. This test is the
// tripwire: it imports the real engram's own constants from the sibling checkout (resolved by
// tests/lwRepo.ts, the same sibling layout every other integration test and the e2e configs rely
// on) and demands exact agreement.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DECAY, LEVELS } from '../src/shared/engram.js';
import { Engram, searchHits } from '../src/server/mcp.js';
import type { HarnessConfig } from '../src/server/config.js';
import { LW_REPO } from './lwRepo.js';


describe('the mirrored mastery contract matches the real engram', () => {
  it('decay windows agree exactly', async () => {
    const theirs = await import(join(LW_REPO, 'src/types.ts'));
    expect(DECAY).toEqual(theirs.DECAY);
  });

  it('mastery levels agree exactly, order included — indexOf comparisons depend on it', async () => {
    const theirs = await import(join(LW_REPO, 'src/types.ts'));
    expect(LEVELS).toEqual(theirs.LEVELS);
  });
});

// Every engram tool name myelin references by string literal anywhere in src/server: the union of
// READ_ONLY_ENGRAM_TOOLS (mcp.ts) and every `lw.call('<name>', ...)` call site (grepped across
// src/server). If the real engram ever renames or drops one of these, every myelin call site using
// it breaks at runtime with no compile-time signal — this test is the tripwire.
const EXPECTED_ENGRAM_TOOLS = [
  'author_affinity', 'compile_source', 'create_path', 'find_analogies', 'get_student_state',
  'link_pages', 'list_pages', 'list_paths', 'next_lessons', 'read_page', 'read_path',
  'record_evidence', 'search', 'working_set', 'write_page',
];

// The list above is typed by hand, which is how it goes stale: a new `lw.call('x', ...)` site
// ships, nobody adds 'x' here, and the tripwire below quietly stops covering it.
describe('EXPECTED_ENGRAM_TOOLS covers every call site', () => {
  it('names every tool src/server calls by string literal', () => {
    const root = join(import.meta.dirname, '..', 'src', 'server');
    const called = new Set<string>();
    for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (!entry.endsWith('.ts')) continue;
      const text = readFileSync(join(root, entry), 'utf8');
      for (const m of text.matchAll(/\blw\.call\(\s*'([a-z_]+)'/g)) called.add(m[1]);
    }
    expect(called.size).toBeGreaterThan(10); // the scan itself must be finding call sites
    expect([...called].filter((name) => !EXPECTED_ENGRAM_TOOLS.includes(name))).toEqual([]);
  });
});

describe('the real engram exposes every tool myelin calls by name (T13)', () => {
  let lw: Engram;
  let vault: string;

  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), 'lwh-contract-vault-'));
    mkdirSync(join(vault, 'pages'), { recursive: true });
    writeFileSync(join(vault, 'pages', 'derivatives.md'),
      '---\ntitle: Derivatives\ndifficulty: 1\nstatus: solid\n---\nrates of change');
    const cfg = {
      vault, student: 'testkid',
      engram: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
    } as HarnessConfig;
    lw = await Engram.connect(cfg);
  }, 30_000);

  afterAll(async () => { await lw.close(); });

  it('lists every tool myelin calls by name', async () => {
    const names = new Set((await lw.tools()).map((t) => t.name));
    for (const name of EXPECTED_ENGRAM_TOOLS) expect(names, name).toContain(name);
  });

  // T13: engram's `search` result changed shape from a bare array to `{results, note?}`.
  // searchHits() must keep working against the REAL engram's current response, not just a
  // hand-shaped fixture — a unit test on a fixture would not have caught the shape change itself.
  it('search results parse through searchHits() with slug and numeric score on every hit', async () => {
    const res = await lw.call('search', { query: 'rates of change' });
    const hits = searchHits(res);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(typeof h.slug).toBe('string');
      expect(h.slug.length).toBeGreaterThan(0);
      expect(typeof h.score).toBe('number');
    }
  }, 30_000);
}, 60_000);
