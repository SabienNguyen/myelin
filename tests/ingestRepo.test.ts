import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveRepoName, discoverDocFiles, ingestRepo, isGitUrl, runCommand,
} from '../src/server/ingestRepo.js';
import type { RepoMineReport } from '../src/server/gap/mineRepo.js';
import { readQueue } from '../src/server/ingest.js';
import { readLinkDirectories } from '../src/server/linkList.js';
import type { HarnessConfig } from '../src/server/config.js';

/** Poll until fn() is truthy — ingestRepo's background phases (mirrors ingestRoutes.test.ts's
 * own `until` for startConversion's background work). */
async function until<T>(fn: () => T, ms = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('until(): timeout');
    await new Promise((r) => { setTimeout(r, 15); });
  }
}

function cfgFor(vault: string): HarnessConfig {
  return { vault, student: 'kid', models: {}, autoCompile: false } as unknown as HarnessConfig;
}

function fakeLw(writes: any[] = [], slugs: string[] = []) {
  return {
    listSlugs: async () => slugs,
    call: async (name: string, args: Record<string, unknown>) => {
      if (name === 'write_page') writes.push(args);
      return { ok: true };
    },
  } as any;
}

/** A no-op mining pass — every orchestration test below that isn't specifically exercising the
 * mining pass supplies this, so it never falls through to the real mineRepoBuiltin (which would
 * call a real model). */
const noopMiner = async (): Promise<RepoMineReport> => ({ candidates: 0, qualified: 0, authored: [], rejected: [] });

describe('isGitUrl / deriveRepoName', () => {
  it('recognizes https/git@/ssh/git URL forms', () => {
    expect(isGitUrl('https://github.com/foo/bar.git')).toBe(true);
    expect(isGitUrl('git@github.com:foo/bar.git')).toBe(true);
    expect(isGitUrl('ssh://git@github.com/foo/bar.git')).toBe(true);
    expect(isGitUrl('/home/user/repo')).toBe(false);
  });

  it('derives the basename minus .git from URLs, and the dir basename from local paths', () => {
    expect(deriveRepoName('https://github.com/foo/bar.git')).toBe('bar');
    expect(deriveRepoName('https://github.com/foo/bar')).toBe('bar');
    expect(deriveRepoName('git@github.com:foo/bar.git')).toBe('bar');
    expect(deriveRepoName('/home/user/my-repo')).toBe('my-repo');
    expect(deriveRepoName('/home/user/my-repo/')).toBe('my-repo');
  });

  it('rejects names outside the allowlist (path-traversal guard, mirrors sessionStore THREAD_ID)', () => {
    expect(() => deriveRepoName('https://github.com/foo/bar.baz.git')).toThrow(/could not derive a safe name/);
    expect(() => deriveRepoName('/tmp/my.repo')).toThrow(/could not derive a safe name/);
    expect(() => deriveRepoName('/')).toThrow(/could not derive a safe name/);
  });
});

describe('discoverDocFiles', () => {
  it('finds README* + root *.md + docs/**/*.md, skipping node_modules, capped and deduped', () => {
    const repo = mkdtempSync(join(tmpdir(), 'lwh-docfiles-'));
    writeFileSync(join(repo, 'README.md'), '# readme');
    writeFileSync(join(repo, 'CHANGELOG.md'), '# changelog');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'a.md'), '# a');
    mkdirSync(join(repo, 'docs', 'sub'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'sub', 'b.md'), '# b');
    mkdirSync(join(repo, 'docs', 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'node_modules', 'skip.md'), '# skip me');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'not-a-doc.md'), '# not discovered (not root/docs)');

    const files = discoverDocFiles(repo);
    expect(files).toContain('README.md');
    expect(files).toContain('CHANGELOG.md');
    expect(files).toContain('docs/a.md');
    expect(files).toContain('docs/sub/b.md');
    expect(files).not.toContain('docs/node_modules/skip.md');
    expect(files).not.toContain('src/not-a-doc.md');
    expect(new Set(files).size).toBe(files.length); // deduped
  });

  it('caps at 30 files', () => {
    const repo = mkdtempSync(join(tmpdir(), 'lwh-docfiles-cap-'));
    mkdirSync(join(repo, 'docs'), { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(repo, 'docs', `d${i}.md`), `# ${i}`);
    expect(discoverDocFiles(repo)).toHaveLength(30);
  });

  it('returns [] for a repo with no markdown files at all — not an error', () => {
    const repo = mkdtempSync(join(tmpdir(), 'lwh-docfiles-none-'));
    writeFileSync(join(repo, 'index.ts'), 'export {};');
    expect(discoverDocFiles(repo)).toEqual([]);
  });
});

describe('ingestRepo orchestration (local path source)', () => {
  function repoFixture(opts: { docs?: boolean } = {}): string {
    const repo = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-'));
    if (opts.docs !== false) {
      // A single H1: splitChapters (existing chapter pipeline) falls back to one whole-doc
      // chapter when there are fewer than two headings at any one level — exactly one pending
      // ledger entry, which is what this fixture's assertions below expect.
      writeFileSync(join(repo, 'README.md'), '# My Repo\nSome intro text about the project.');
    }
    return repo;
  }

  it('runs docs pass + mining pass and completes with a docs/exercises summary', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-vault-'));
    const repo = repoFixture();
    const cfg = cfgFor(vault);

    const minerCalls: { repoName: string; repoPath: string }[] = [];
    const writes: any[] = [];
    const lw = fakeLw(writes);

    const result = ingestRepo(lw, cfg, repo, {
      builtinMiner: async (repoName, repoPath) => {
        minerCalls.push({ repoName, repoPath });
        return { candidates: 3, qualified: 1, authored: ['widgets-pick'], rejected: [] };
      },
    });

    expect(result).toEqual({ name: expect.any(String), ingesting: true });
    const placeholderBook = result.name;

    await until(() => readQueue(vault).find((e) => e.book === placeholderBook && e.status === 'done'));
    const entry = readQueue(vault).find((e) => e.book === placeholderBook && e.mode === 'repo')!;
    expect(entry.status).toBe('done');
    expect(entry.phase).toContain('docs: 1 queued');
    expect(entry.phase).toContain('1 exercise ready to practise in the Library');

    // docs pass queued exactly one normal pending chapter (README's single H1-split section).
    const docEntries = readQueue(vault).filter((e) => e.book === placeholderBook && e.mode !== 'repo');
    expect(docEntries).toHaveLength(1);
    expect(docEntries[0].status).toBe('pending');
    expect(docEntries[0].sourceUrl).toBe(`${repo} — README.md`);

    // the mining pass ran against the resolved repo checkout, in-process — no external CLI.
    expect(minerCalls).toHaveLength(1);
    expect(minerCalls[0].repoPath).toBe(repo);
  });

  it('flows through discoverable phase text: cloning is skipped for a local path, straight to docs/mining', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-vault-'));
    const repo = repoFixture({ docs: false }); // no README/docs — zero markdown files
    const cfg = cfgFor(vault);
    const writes: any[] = [];
    const lw = fakeLw(writes);

    const result = ingestRepo(lw, cfg, repo, { builtinMiner: noopMiner });

    await until(() => readQueue(vault).find((e) => e.book === result.name && e.status === 'done'));
    const entry = readQueue(vault).find((e) => e.book === result.name)!;
    // The FINAL phase text comes from runBuiltinPass's finish() call, not the intermediate
    // "no markdown files found" phase — that one is overwritten once mining completes.
    expect(entry.phase).toBe('docs: 0 queued — no exercises authored (0/0 candidate functions qualified)');

    const docEntries = readQueue(vault).filter((e) => e.book === result.name && e.mode !== 'repo');
    expect(docEntries).toHaveLength(0); // zero markdown files is fine, not an error
  });

  it('mining authoring failure still reports done — the docs pass already succeeded', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-vault-'));
    const repo = repoFixture({ docs: false });
    const cfg = cfgFor(vault);

    const result = ingestRepo(fakeLw(), cfg, repo, {
      builtinMiner: async () => { throw new Error('model unreachable'); },
    });

    await until(() => readQueue(vault).find((e) => e.book === result.name && e.status === 'done'));
    const entry = readQueue(vault).find((e) => e.book === result.name)!;
    expect(entry.status).toBe('done');
    expect(entry.phase).toContain('exercise authoring failed: model unreachable');
  });

  // Pins the real production incident: ingestRepo.ts used to pick its miner with
  // `deps.miner !== undefined || existsSync(THE_GAP_ROOT)`, where THE_GAP_ROOT defaulted to
  // ~/Dev/personal/the-gap — an unrelated directory in the developer's home folder. On a machine
  // that happened to have that checkout, a real ingest took the external CLI path and mined ZERO
  // artifacts, while the built-in miner found 932 qualifying candidates in the identical clone.
  // The outcome must never again depend on what else exists on disk — mining always runs the
  // built-in pass now, so a the-gap-shaped directory sitting right next to the repo changes
  // nothing.
  it('mines through the built-in pass even when a the-gap-shaped directory exists on disk', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lwh-fake-home-'));
    const theGapLookalike = join(home, 'Dev', 'personal', 'the-gap');
    mkdirSync(theGapLookalike, { recursive: true });
    writeFileSync(join(theGapLookalike, 'package.json'), '{"name":"@the-gap/miner"}');

    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-vault-'));
    const repo = repoFixture({ docs: false });
    const cfg = cfgFor(vault);

    let builtinRan = false;
    const result = ingestRepo(fakeLw(), cfg, repo, {
      builtinMiner: async () => {
        builtinRan = true;
        return { candidates: 5, qualified: 2, authored: ['a', 'b'], rejected: [] };
      },
    });

    await until(() => readQueue(vault).find((e) => e.book === result.name && e.status === 'done'));
    const entry = readQueue(vault).find((e) => e.book === result.name)!;
    expect(builtinRan).toBe(true);
    expect(entry.phase).toContain('2 exercises ready to practise in the Library');
  });

  it('a nonexistent local path 400s synchronously (throws before any ledger write)', () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-vault-'));
    const cfg = cfgFor(vault);
    expect(() => ingestRepo(fakeLw(), cfg, '/definitely/does/not/exist-xyz', {})).toThrow(/does not exist/);
    expect(readQueue(vault)).toHaveLength(0);
  });

  it('a relative local path is rejected (absolute paths only)', () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-vault-'));
    const cfg = cfgFor(vault);
    expect(() => ingestRepo(fakeLw(), cfg, 'relative/path', {})).toThrow(/must be absolute/);
  });

  it('a bad-name source throws synchronously, before any ledger write', () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-vault-'));
    const cfg = cfgFor(vault);
    expect(() => ingestRepo(fakeLw(), cfg, 'https://github.com/foo/bar.baz.git', {})).toThrow(
      /could not derive a safe name/,
    );
    expect(readQueue(vault)).toHaveLength(0);
  });
});

describe('ingestRepo — link-directory explosion', () => {
  // An awesome-list README: sections of external-link bullets. Enough links to clear detection,
  // shaped exactly like the real thing (intro prose, badge, blurbed bullets).
  function awesomeRepoFixture(): string {
    const repo = mkdtempSync(join(tmpdir(), 'lwh-awesome-'));
    const links = (section: string, n: number) => Array.from(
      { length: n },
      (_, i) => `- [${section} ${i + 1}](https://blog.example/${section.toLowerCase()}-${i}) - a ${section.toLowerCase()} reading`,
    ).join('\n');
    writeFileSync(join(repo, 'README.md'), [
      '# Awesome Distributed Systems', '',
      'A curated list of readings.', '',
      '## Principles', '', links('Principles', 10), '',
      '## Practice', '', links('Practice', 10), '',
    ].join('\n'));
    return repo;
  }

  it('catalogues the links, queues NO chapters for the directory, and says so in the ledger', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-vault-'));
    const repo = awesomeRepoFixture();

    const result = ingestRepo(fakeLw(), cfgFor(vault), repo, { builtinMiner: noopMiner });
    await until(() => readQueue(vault).find((e) => e.book === result.name && e.status === 'done'));

    // No chapter entries — the directory was exploded, not compiled into TOC pages.
    const docEntries = readQueue(vault).filter((e) => e.book === result.name && e.mode !== 'repo');
    expect(docEntries).toHaveLength(0);

    // The catalogue exists, grouped by the README's own sections.
    const dirs = readLinkDirectories(vault);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].name).toBe(result.name);
    expect(dirs[0].file).toBe('README.md');
    expect(dirs[0].total).toBe(20);
    expect(dirs[0].sections.map((s) => s.title)).toContain('Principles');
    const first = dirs[0].sections.find((s) => s.title === 'Principles')!.links[0];
    expect(first.url).toBe('https://blog.example/principles-0');
    expect(first.note).toBe('a principles reading');

    // The ledger row carries the receipt.
    const placeholder = readQueue(vault).find((e) => e.book === result.name && e.mode === 'repo')!;
    expect(placeholder.phase).toContain('link directory: 20 catalogued');
  });

  it('an ordinary prose README still compiles as chapters and writes no catalogue', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-vault-'));
    const repo = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-'));
    writeFileSync(join(repo, 'README.md'), '# My Repo\nSome intro text about the project.');

    const result = ingestRepo(fakeLw(), cfgFor(vault), repo, { builtinMiner: noopMiner });
    await until(() => readQueue(vault).find((e) => e.book === result.name && e.status === 'done'));

    expect(readQueue(vault).filter((e) => e.book === result.name && e.mode !== 'repo')).toHaveLength(1);
    expect(readLinkDirectories(vault)).toEqual([]);
  });
});

describe('ingestRepo orchestration (git URL source, clone/reingest dispatch)', () => {
  it('clones into vault/.harness/repos/<name> when no checkout exists yet', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-git-'));
    const cfg = cfgFor(vault);
    const cloneCalls: { source: string; destDir: string }[] = [];

    const result = ingestRepo(fakeLw(), cfg, 'https://example.com/org/widgets.git', {
      clone: async (source, destDir) => {
        cloneCalls.push({ source, destDir });
        mkdirSync(destDir, { recursive: true });
      },
      reingest: async () => { throw new Error('must not reingest — no prior checkout'); },
      builtinMiner: noopMiner,
    });

    expect(result.name).toBe('widgets');
    await until(() => readQueue(vault).find((e) => e.book === 'widgets' && e.status === 'done'));
    expect(cloneCalls).toEqual([
      { source: 'https://example.com/org/widgets.git', destDir: join(vault, '.harness', 'repos', 'widgets') },
    ]);
  });

  it('re-ingests (fetch/reset) rather than cloning when a checkout already exists', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-git-'));
    const cfg = cfgFor(vault);
    const destDir = join(vault, '.harness', 'repos', 'widgets');
    mkdirSync(destDir, { recursive: true }); // simulate a prior clone already on disk

    let reingestCalled = false;
    const result = ingestRepo(fakeLw(), cfg, 'https://example.com/org/widgets.git', {
      clone: async () => { throw new Error('must not clone — a checkout already exists'); },
      reingest: async () => { reingestCalled = true; },
      builtinMiner: noopMiner,
    });

    await until(() => readQueue(vault).find((e) => e.book === result.name && e.status === 'done'));
    expect(reingestCalled).toBe(true);
  });
});

describe('runCommand', () => {
  it('captures the whole of a large stdout, not a truncated tail', async () => {
    // Re-ingest's `git fetch`/`reset` and clone's `git clone` both run through this same spawn
    // helper — a large-output regression here would silently corrupt a real re-ingest's git
    // plumbing output just as it once corrupted the (now-removed) external miner's JSON report.
    const N = 300_000;
    const { stdout } = await runCommand(process.execPath, ['-e', `process.stdout.write("x".repeat(${N}))`]);
    expect(stdout.length).toBe(N);
  });
});
