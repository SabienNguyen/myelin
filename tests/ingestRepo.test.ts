import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveArtifactTitle, deriveRepoName, discoverDocFiles, ingestRepo, isGitUrl, parseMineReport,
  runCommand, seedMinedArtifactPage, type MineReport, type PassedArtifact,
} from '../src/server/ingestRepo.js';
import { readQueue } from '../src/server/ingest.js';
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

describe('deriveArtifactTitle', () => {
  it('prefers the first exported function name, humanized', () => {
    const src = 'export async function fetchAllPages(url) { return []; }';
    expect(deriveArtifactTitle(src, 'Fetch All Pages Ts', 'packages-core-src-fetch-all-pages')).toBe('Fetch All Pages');
  });

  it('handles an exported const arrow function', () => {
    const src = "export const parseThing = (x) => x;\nimport { z } from 'node:zlib';";
    expect(deriveArtifactTitle(src, 'whatever', 'some-id')).toBe('Parse Thing');
  });

  it('falls back to the meta title when no export matches', () => {
    const src = 'function helper() {}\nmodule.exports = helper;';
    expect(deriveArtifactTitle(src, 'Format Helper', 'some-id')).toBe('Format Helper');
  });

  it('falls back to the humanized artifact directory id when source AND meta title are unusable', () => {
    expect(deriveArtifactTitle('', '', 'packages-core-src-tone')).toBe('Packages Core Src Tone');
  });

  it('NEVER returns the literal "Artifact" — the exact bug the queue nit calls out', () => {
    // Adversarial: an exported function literally named Artifact, and a meta title of "Artifact"
    // (the "copied filename" bug this function exists to avoid) — both must be skipped.
    expect(deriveArtifactTitle('export function Artifact() {}', 'Artifact', 'my-mined-id')).toBe('My Mined Id');
    expect(deriveArtifactTitle('no exports here', 'artifact', 'my-mined-id-2')).toBe('My Mined Id 2');
  });
});

describe('parseMineReport', () => {
  const report: MineReport = { candidates: 2, passed: [], rejected: [] };

  it('parses clean JSON stdout', () => {
    expect(parseMineReport(JSON.stringify(report))).toEqual(report);
  });

  it('extracts JSON from stdout with noise around it (e.g. a wrapping pnpm exec banner)', () => {
    const noisy = `Executing via pnpm...\n${JSON.stringify(report)}\n`;
    expect(parseMineReport(noisy)).toEqual(report);
  });

  it('throws with a stderr tail when nothing parseable is present', () => {
    expect(() => parseMineReport('not json at all', 'boom: module not found')).toThrow(/boom: module not found/);
  });
});

describe('seedMinedArtifactPage', () => {
  function fixtureArtifact(source: string, title: string, dirName = 'packages-core-src-fetch-all-pages'): PassedArtifact {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-artifact-'));
    const named = join(dir, dirName);
    mkdirSync(named, { recursive: true });
    writeFileSync(join(named, 'artifact.ts'), source);
    return { dir: named, title, source: { repo: '/repo', commit: 'abc123', path: 'src/fetch.ts' } };
  }

  it('writes a stub page via lw.call(write_page) with a derived title and source citation', async () => {
    const artifact = fixtureArtifact('export function fetchAllPages(url) { return []; }', 'Fetch All Pages Ts');
    const writes: any[] = [];
    const lw = fakeLw(writes);
    const result = await seedMinedArtifactPage(lw, artifact, new Set());

    expect(result).toEqual({ slug: 'packages-core-src-fetch-all-pages', seeded: true, title: 'Fetch All Pages' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      slug: 'packages-core-src-fetch-all-pages',
      title: 'Fetch All Pages',
      status: 'stub',
      domain: 'programming',
    });
    expect(writes[0].sources).toContain('/repo@abc123:src/fetch.ts');
    expect(writes[0].body).toContain('src/fetch.ts');
    // The tutor reads this page freeform to author a code_exercise block's `pattern` field —
    // this line gives it the exact, un-paraphrasable slug to copy (final integration, docs/
    // superpowers/plans/2026-07-21-coding-stage.md contract point 4).
    expect(writes[0].body).toContain('pattern: packages-core-src-fetch-all-pages');
  });

  it('is idempotent — skips a slug already in existingSlugs, never calls write_page', async () => {
    const artifact = fixtureArtifact('export function x() {}', 'X', 'already-seeded-id');
    const writes: any[] = [];
    const lw = fakeLw(writes);
    const result = await seedMinedArtifactPage(lw, artifact, new Set(['already-seeded-id']));

    expect(result).toEqual({ slug: 'already-seeded-id', seeded: false, title: 'X' });
    expect(writes).toHaveLength(0);
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

  function passedArtifactFixture(dirName: string, source = 'export function pick(x) { return x; }'): PassedArtifact {
    const outer = mkdtempSync(join(tmpdir(), 'lwh-mined-'));
    const dir = join(outer, dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'artifact.ts'), source);
    return { dir, title: 'Pick', source: { repo: '/repo', commit: 'deadbeef', path: 'src/pick.ts' } };
  }

  it('runs docs pass + mining pass, seeds pages, and completes with a pages/exercises summary', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-vault-'));
    const repo = repoFixture();
    const cfg = cfgFor(vault);

    const minerCalls: { repoPath: string; outDir: string }[] = [];
    const report: MineReport = {
      candidates: 1,
      passed: [passedArtifactFixture('mined-pick')],
      rejected: [],
    };
    const restartCalls: string[] = [];
    const writes: any[] = [];
    const lw = fakeLw(writes);

    const result = ingestRepo(lw, cfg, repo, {
      miner: async (repoPath, outDir) => { minerCalls.push({ repoPath, outDir }); return report; },
      restartSidecar: async () => { restartCalls.push('restarted'); },
      pingGap: async () => true,
    });

    expect(result).toEqual({ name: expect.any(String), ingesting: true });
    const placeholderBook = result.name;

    await until(() => readQueue(vault).find((e) => e.book === placeholderBook && e.status === 'done'));
    const entry = readQueue(vault).find((e) => e.book === placeholderBook && e.mode === 'repo')!;
    expect(entry.phase).toBe('pages: 1 queued, exercises: 1');
    expect(entry.status).toBe('done');

    // docs pass queued exactly one normal pending chapter (README's single H1-split section).
    const docEntries = readQueue(vault).filter((e) => e.book === placeholderBook && e.mode !== 'repo');
    expect(docEntries).toHaveLength(1);
    expect(docEntries[0].status).toBe('pending');
    expect(docEntries[0].sourceUrl).toBe(`${repo} — README.md`);

    // mining pass ran with a FLAT --out dir under vault/.harness/mined.
    expect(minerCalls).toHaveLength(1);
    expect(minerCalls[0].repoPath).toBe(repo);
    expect(minerCalls[0].outDir).toBe(join(vault, '.harness', 'mined'));

    // seeding happened, with the derived (exported-function) title, not the meta "Pick" title verbatim
    // truncated — here the export name IS "pick", so humanized -> "Pick", matching meta anyway.
    expect(writes).toHaveLength(1);
    expect(writes[0].slug).toBe('mined-pick');
    expect(writes[0].title).toBe('Pick');

    // sidecar restarted + polled since >=1 artifact passed.
    expect(restartCalls).toEqual(['restarted']);
  });

  it('flows through discoverable phase text: cloning is skipped for a local path, straight to docs/mining', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-vault-'));
    const repo = repoFixture({ docs: false }); // no README/docs — zero markdown files
    const cfg = cfgFor(vault);
    const writes: any[] = [];
    const lw = fakeLw(writes);

    const result = ingestRepo(lw, cfg, repo, {
      miner: async () => ({ candidates: 0, passed: [], rejected: [] }),
      restartSidecar: async () => { throw new Error('must not be called — nothing passed'); },
    });

    await until(() => readQueue(vault).find((e) => e.book === result.name && e.status === 'done'));
    const entry = readQueue(vault).find((e) => e.book === result.name)!;
    expect(entry.phase).toBe('pages: 0 queued, exercises: 0');

    const docEntries = readQueue(vault).filter((e) => e.book === result.name && e.mode !== 'repo');
    expect(docEntries).toHaveLength(0); // zero markdown files is fine, not an error
  });

  it('an external miner failure FALLS BACK to the built-in pass, naming the failure, never touching the sidecar', async () => {
    // The 'mining failed: spawn npm ENOENT' dead end: a the-gap checkout exists but its toolchain
    // is broken (the packaged app's normal state). The ingest must still mine — via the built-in
    // pass — and the ledger must still say the external CLI died.
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-vault-'));
    const repo = repoFixture();
    const cfg = cfgFor(vault);
    let restarted = false;
    let builtinRan = false;

    const result = ingestRepo(fakeLw(), cfg, repo, {
      miner: async () => { throw new Error('miner exploded: no module foo'); },
      builtinMiner: async () => {
        builtinRan = true;
        return { candidates: 2, qualified: 1, pending: ['x-clamp'], rejected: [] };
      },
      restartSidecar: async () => { restarted = true; },
    });

    await until(() => readQueue(vault).find((e) => e.book === result.name && e.status === 'done'));
    const entry = readQueue(vault).find((e) => e.book === result.name)!;
    expect(builtinRan).toBe(true);
    expect(entry.status).toBe('done');
    expect(entry.phase).toMatch(/external miner failed \(miner exploded: no module foo\)/);
    expect(entry.phase).toMatch(/waiting for your approval/);
    expect(restarted).toBe(false);
  });

  it('warns (but still finishes done) when the sidecar does not come back up in time', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-vault-'));
    const repo = repoFixture({ docs: false });
    const cfg = cfgFor(vault);
    const writes: any[] = [];

    const result = ingestRepo(fakeLw(writes), cfg, repo, {
      miner: async () => ({ candidates: 1, passed: [passedArtifactFixture('warn-artifact')], rejected: [] }),
      restartSidecar: async () => {},
      pingGap: async () => false, // never comes up
      gapRestartTimeoutMs: 1, // tiny timeout — the poll gives up on its very first failed ping
    });

    await until(() => readQueue(vault).find((e) => e.book === result.name && e.status === 'done'));
    const entry = readQueue(vault).find((e) => e.book === result.name)!;
    expect(entry.status).toBe('done'); // warning is not fatal
    expect(entry.phase).toMatch(/did not come back up/);
  });

  it('does not restart the sidecar when nothing passed the gauntlet', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingestrepo-vault-'));
    const repo = repoFixture({ docs: false });
    const cfg = cfgFor(vault);
    let restartCalled = false;

    const result = ingestRepo(fakeLw(), cfg, repo, {
      miner: async () => ({ candidates: 3, passed: [], rejected: [{ path: 'a.ts', gate: 'gate1', reason: 'nope' }] }),
      restartSidecar: async () => { restartCalled = true; },
    });

    await until(() => readQueue(vault).find((e) => e.book === result.name && e.status === 'done'));
    expect(restartCalled).toBe(false);
    const entry = readQueue(vault).find((e) => e.book === result.name)!;
    expect(entry.phase).toBe('pages: 0 queued, exercises: 0');
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
      miner: async () => ({ candidates: 0, passed: [], rejected: [] }),
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
      miner: async () => ({ candidates: 0, passed: [], rejected: [] }),
    });

    await until(() => readQueue(vault).find((e) => e.book === result.name && e.status === 'done'));
    expect(reingestCalled).toBe(true);
  });
});

describe('runCommand', () => {
  it('captures the whole of a large stdout, not a truncated tail', async () => {
    // The miner's JSON report arrives on stdout and parseMineReport must see all of it. Resolving on
    // 'exit' rather than 'close' truncated the capture once output passed the OS pipe buffer (~64KB):
    // the process had ended but its stdout pipe still held unread bytes. 300KB is well past that, so
    // this would come back short under the old event; on 'close' it is always complete.
    const N = 300_000;
    const { stdout } = await runCommand(process.execPath, ['-e', `process.stdout.write("x".repeat(${N}))`]);
    expect(stdout.length).toBe(N);
  });
});
