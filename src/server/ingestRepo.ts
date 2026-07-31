// B2c (docs/superpowers/plans/2026-07-21-coding-stage.md section B2): "Add repo" ingestion — the
// final integration of the repo-learning pipeline. Mirrors ingest.ts's book/paper pipeline (a
// single reload-safe 'converting' placeholder, written IMMEDIATELY, updated in place as work
// progresses) but drives THREE phases behind that one placeholder instead of one conversion:
//   1. resolve a local checkout of the repo (clone/re-clone a git URL, or use a local path in
//      place — never copied),
//   2. a DOCS PASS that queues README/docs/*.md through the EXISTING chapter->compile pipeline
//      (ingest.ts's splitChapters + the ledger's normal 'pending' entries — untouched, no new
//      code path for compiling),
//   3. a MINING PASS that runs the built-in miner (src/server/gap/mineRepo.ts) over the checkout,
//      turning qualifying functions into code exercises verified by the standard gates and
//      queued for approval in the Library.
//
// Mining used to be able to shell out to an EXTERNAL the-gap CLI checkout when one happened to
// exist on disk (see docs/superpowers/plans/2026-07-20-gap-integration.md) — removed after an
// incident where that checkout's mere presence on a developer's machine silently switched a repo
// ingest onto a path that mined zero artifacts, while the built-in pass mined 932 candidates from
// the same clone. A packaged desktop app can never have that checkout, so the external path was
// dead weight there by definition; mining now always runs in-process.
//
// Every external effect (clone, re-clone) is injectable via IngestRepoDeps so ingestRepo() itself
// is unit-testable without a network or a real git binary.

import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import {
  basename, dirname, isAbsolute, join, sep,
} from 'node:path';
import type { HarnessConfig } from './config.js';
import { splitChapters } from './convert.js';
import { compileGenerate } from './gap/generateSeam.js';
import { mineRepoBuiltin, type RepoMineReport } from './gap/mineRepo.js';
import { ensureCompileDrain, slugify } from './ingest.js';
import { analyzeLinkList, saveLinkDirectory, type DirectorySection } from './linkList.js';
import type { Engram } from './mcp.js';
import { recordIngest } from './provenance.js';
import { enqueueChapters, readQueue, updateQueue, writeQueue, type QueueEntry } from './queueStore.js';

// ── name/source derivation ──────────────────────────────────────────────────────────────────

// Same allowlist as sessionStore.ts's THREAD_ID — a repo's derived name becomes a directory
// basename under vault/.harness/repos/ AND a vault page-adjacent book/slug, so the same
// path-traversal guard applies for the same reason (duplicated locally rather than imported:
// sessionStore.ts doesn't export the regex itself, only the assert built on it).
const REPO_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const GIT_URL_RE = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i;

export function isGitUrl(source: string): boolean {
  return GIT_URL_RE.test(source.trim());
}

/**
 * URL basename minus `.git`, or local dir basename — sanitized through REPO_NAME_RE. Throws a
 * descriptive Error (never returns an unsafe value) on anything that doesn't survive the
 * allowlist, e.g. a dotted name ("socket.io"), an empty name, or a bare domain with no path.
 * A git URL's name is derived without a URL parser (scp-like `git@host:owner/repo.git` isn't a
 * valid URL) — split on the last `/` or `:` instead, which handles both forms identically.
 */
export function deriveRepoName(source: string): string {
  const trimmed = source.trim().replace(/\/+$/, '');
  let raw: string;
  if (isGitUrl(trimmed)) {
    raw = (trimmed.split(/[/:]/).pop() ?? '').replace(/\.git$/i, '');
  } else {
    raw = basename(trimmed);
  }
  if (!REPO_NAME_RE.test(raw)) {
    throw new Error(
      `could not derive a safe name from source ${JSON.stringify(source)} (got ${JSON.stringify(raw)}, `
      + `must match ${REPO_NAME_RE}) — rename the repo or pass a different URL/path`,
    );
  }
  return raw;
}

// ── doc-file discovery (contract point 3) ───────────────────────────────────────────────────

const DOC_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'vendor']);
const MAX_DOC_FILES = 30;

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}
function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function listDir(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}

function walkMarkdown(dir: string, repoPath: string, out: string[]): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (DOC_SKIP_DIRS.has(entry.name)) continue;
      walkMarkdown(full, repoPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full.slice(repoPath.length + 1).split(sep).join('/'));
    }
  }
}

/**
 * README* (any extension) plus *.md at repo root, plus docs/**\/*.md (recursive, skipping
 * node_modules/dist/build/.git/vendor) — capped at MAX_DOC_FILES, deduped, relative POSIX paths.
 * Zero files back is normal (an undocumented or docs-elsewhere repo), not an error — see
 * ingestRepo()'s 'docs: 0 queued' phase text.
 */
export function discoverDocFiles(repoPath: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (rel: string) => { if (!seen.has(rel)) { seen.add(rel); ordered.push(rel); } };

  const rootEntries = listDir(repoPath);
  for (const name of rootEntries) {
    if (/^readme/i.test(name) && isFile(join(repoPath, name))) add(name);
  }
  for (const name of rootEntries) {
    if (name.toLowerCase().endsWith('.md') && isFile(join(repoPath, name))) add(name);
  }
  const docsDir = join(repoPath, 'docs');
  if (isDir(docsDir)) {
    const docsFiles: string[] = [];
    walkMarkdown(docsDir, repoPath, docsFiles);
    docsFiles.sort();
    for (const rel of docsFiles) add(rel);
  }

  return ordered.slice(0, MAX_DOC_FILES);
}

// ── external-process helpers (default IngestRepoDeps implementations) ──────────────────────

// Exported for the large-output test — the truncation this guards against only shows past the pipe
// buffer, so it needs a real spawn to exercise.
export function runCommand(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    // 'close', NOT 'exit': 'exit' fires when the process ends but its stdout/stderr pipes may still
    // hold unread buffered data, so resolving there would truncate the capture. 'close' fires only
    // once every stdio stream has drained. Every other spawn helper in this codebase (runner.ts,
    // exec.ts, environment.ts) already waits on 'close' for this reason.
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`), { stdout, stderr }));
    });
  });
}

async function defaultClone(source: string, destDir: string): Promise<void> {
  mkdirSync(dirname(destDir), { recursive: true });
  await runCommand('git', ['clone', '--depth', '1', source, destDir]);
}

// Re-ingest strategy (documented design decision): fetch --depth 1 + reset --hard FETCH_HEAD,
// falling back to rm+reclone if the existing checkout isn't a healthy git repo (corrupt clone,
// detached remote, etc). Chosen over an unconditional rm+reclone because it avoids re-downloading
// a possibly-large repo's whole history every re-ingest; chosen over `git pull` because it never
// needs to know the remote's default branch name (`origin HEAD` resolves it) and can't produce a
// merge conflict against local changes (there never are any — this checkout is never edited by
// hand). `--depth 1` keeps the refreshed history exactly as shallow as a fresh clone, so repeated
// re-ingests don't accumulate history bloat either.
async function defaultReingest(source: string, destDir: string): Promise<void> {
  try {
    await runCommand('git', ['fetch', '--depth', '1', 'origin', 'HEAD'], { cwd: destDir });
    await runCommand('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: destDir });
  } catch {
    rmSync(destDir, { recursive: true, force: true });
    await defaultClone(source, destDir);
  }
}

// ── orchestration ────────────────────────────────────────────────────────────────────────

export interface IngestRepoDeps {
  clone?: (source: string, destDir: string) => Promise<void>;
  reingest?: (source: string, destDir: string) => Promise<void>;
  /** The mining pass (gap/mineRepo.ts). Injectable so tests don't need a model. */
  builtinMiner?: (repoName: string, repoPath: string) => Promise<RepoMineReport>;
}

/**
 * Kicks off a repo ingest: validates + derives the repo name synchronously (bad name / bad local
 * path throw here, so the route can 400 immediately — nothing async has started yet), writes a
 * single reload-safe 'converting' placeholder (mode: 'repo') to the SAME compile-queue.json ledger
 * the Library already renders, then runs clone/re-clone -> docs pass -> mining pass in the
 * background, updating the placeholder's `phase` text as each stage completes. Returns as soon as
 * the placeholder is queued, exactly like startConversion.
 *
 * Ledger-write note: the INITIAL placeholder push just below is a direct readQueue+writeQueue
 * pair, not routed through updateQueue's async mutex — same reason as startConversion's own
 * initial push (see ingest.ts): this function returns synchronously and its only caller
 * (ingestRoutes.ts's POST /api/ingest/repo) relies on the placeholder being durably on disk the
 * instant it returns. Safe because nothing async happens between this read and this write. Every
 * OTHER ledger write below (setPhase, finish, the docs-pass loop) runs in the background
 * continuation, arbitrarily far past an await, and goes through updateQueue — see queueStore.ts's
 * module doc comment for the incident that requires this.
 */
export function ingestRepo(
  lw: Engram, cfg: HarnessConfig, source: string, deps: IngestRepoDeps = {},
): { name: string; ingesting: true } {
  const trimmedSource = source.trim();
  if (!trimmedSource) throw new Error('source must not be empty');
  const name = deriveRepoName(trimmedSource);
  const gitUrl = isGitUrl(trimmedSource);

  let repoPath: string;
  if (gitUrl) {
    repoPath = join(cfg.vault, '.harness', 'repos', name);
  } else {
    if (!isAbsolute(trimmedSource)) {
      throw new Error(`local repo path must be absolute: ${JSON.stringify(trimmedSource)}`);
    }
    if (!existsSync(trimmedSource) || !statSync(trimmedSource).isDirectory()) {
      throw new Error(`local repo path does not exist or is not a directory: ${JSON.stringify(trimmedSource)}`);
    }
    repoPath = trimmedSource;
  }

  const placeholderKey = `__ingesting_repo__/${Date.now().toString(36)}`;
  const ledger = readQueue(cfg.vault);
  ledger.push({
    book: name,
    chapter: placeholderKey,
    title: 'Ingesting repo…',
    mode: 'repo',
    status: 'converting',
    startedAt: new Date().toISOString(),
    sourceUrl: trimmedSource,
    phase: 'cloning',
  });
  writeQueue(cfg.vault, ledger);

  // A repo credits itself in a hundred half-authoritative ways (git history, a LICENSE, a
  // package.json `author`) and none of them is the byline a learner chooses material by, so nothing
  // here is `reported` — the record exists to say where the material came from and, honestly, that
  // nobody is credited. The docs-pass chapters queue under this same `book` name, so a later
  // re-ingest replaces this record rather than stacking one.
  recordIngest(cfg.vault, { book: name, title: name, origin: { kind: 'repo', url: trimmedSource } });

  async function setPhase(phase: string): Promise<void> {
    await updateQueue(cfg.vault, (entries) => {
      const ph = entries.find((e) => e.chapter === placeholderKey);
      if (ph) ph.phase = phase;
    });
  }
  async function finish(status: 'done' | 'error', phase: string, error?: string): Promise<void> {
    await updateQueue(cfg.vault, (entries) => {
      const ph = entries.find((e) => e.chapter === placeholderKey);
      if (ph) {
        ph.status = status;
        ph.phase = phase;
        if (error) ph.error = error;
      }
    });
  }

  void (async () => {
    try {
      if (gitUrl) {
        if (existsSync(repoPath)) {
          await (deps.reingest ?? defaultReingest)(trimmedSource, repoPath);
        } else {
          await (deps.clone ?? defaultClone)(trimmedSource, repoPath);
        }
      }
      // else: local path, used in place — nothing to resolve.

      // ── docs pass (contract point 3): normal pending chapters, existing compile pipeline ──
      const docFiles = discoverDocFiles(repoPath);
      const repoSlug = slugify(name) || 'repo';
      const uploadsDir = join(cfg.vault, 'raw', 'uploads', repoSlug);
      let queuedChapters = 0;
      // Link-directory explosion: a doc file that is overwhelmingly a curated list of external
      // links (awesome-list shape — see linkList.ts) would compile into pages that are just themed
      // tables of contents, since the compiler never follows links. Those files are EXPLODED
      // instead of compiled: their links become a browsable catalogue in the Library, each one
      // click from the single-document ingest that handles it well.
      const linkListFiles: string[] = [];
      const linkSections: DirectorySection[] = [];
      let cataloguedLinks = 0;
      let omittedLinks = 0;
      if (docFiles.length > 0) mkdirSync(uploadsDir, { recursive: true });
      for (const relPath of docFiles) {
        const raw = readFileSync(join(repoPath, relPath), 'utf8');
        const analysis = analyzeLinkList(raw);
        if (analysis.isLinkList) {
          linkListFiles.push(relPath);
          linkSections.push(...analysis.sections);
          cataloguedLinks += analysis.total;
          omittedLinks += analysis.omitted;
          continue; // catalogued, not compiled — no chapter entries for a directory
        }
        const chapters = splitChapters(raw);
        const fileSlug = slugify(relPath.replace(/\.md$/i, '')) || 'doc';
        const newEntries: QueueEntry[] = chapters.map((ch, i) => {
          const n = i + 1;
          const chapterSlug = slugify(ch.title) || `chapter-${n}`;
          const filename = `${fileSlug}--ch-${String(n).padStart(2, '0')}-${chapterSlug}.md`;
          const header = `<!-- source: "${name}", file "${relPath}", chapter ${n}: "${ch.title}" -->\n\n`;
          writeFileSync(join(uploadsDir, filename), `${header}${ch.body}\n`);
          return {
            book: name,
            chapter: `raw/uploads/${repoSlug}/${filename}`,
            title: ch.title,
            status: 'pending' as const,
            sourceUrl: `${trimmedSource} — ${relPath}`,
          };
        });
        // Targeted push via updateQueue (re-reads fresh, inside the mutex) rather than the
        // read-once-hold-across-the-loop pattern that ate tonight's rows elsewhere — see
        // queueStore.ts's module doc comment. This is exactly the write that lost 15 rows in
        // production: a repo ingest's placeholder + these per-doc-file chapter pushes.
        await updateQueue(cfg.vault, (entries) => { enqueueChapters(entries, newEntries); });
        queuedChapters += chapters.length;
      }
      if (linkListFiles.length > 0) {
        saveLinkDirectory(cfg.vault, {
          name,
          source: trimmedSource,
          file: linkListFiles.join(', '),
          savedAt: new Date().toISOString(),
          sections: linkSections,
          total: cataloguedLinks,
          omitted: omittedLinks,
        });
      }
      // The link note rides every later phase string so the catalogue's existence never scrolls
      // away — the ledger row is the only receipt the learner gets that their paste did something.
      const linkNote = cataloguedLinks > 0
        ? `, link directory: ${cataloguedLinks} catalogued${omittedLinks ? ` (${omittedLinks} past the cap)` : ''}`
        : '';
      await setPhase(docFiles.length > 0
        ? `docs: ${queuedChapters} queued${linkNote}`
        : 'docs: 0 queued (no markdown files found)');
      if (cfg.autoCompile !== false) ensureCompileDrain(lw, cfg);

      // ── mining pass (contract point 4) — always the built-in pass, see this file's top ─────
      await setPhase('authoring exercises from the code…');
      try {
        const mined = await (deps.builtinMiner
          ?? ((rn: string, rp: string) => mineRepoBuiltin(cfg.vault, rn, rp, {
            generate: compileGenerate(cfg), modelName: cfg.models.compile.model,
          })))(name, repoPath);
        const summary = mined.authored.length > 0
          ? `${mined.authored.length} exercise${mined.authored.length === 1 ? '' : 's'} ready to practise in the Library`
          : `no exercises authored (${mined.qualified}/${mined.candidates} candidate functions qualified)`;
        // mined.note names a skipped language (e.g. python3 missing) — without it, a Python
        // repo's "0 candidates" reads as a miner fault instead of a missing runtime.
        await finish('done', `docs: ${queuedChapters} queued${linkNote} — ${summary}${mined.rejected.length ? ` — ${mined.rejected.length} rejected by the gates` : ''}${mined.note ? ` — ${mined.note}` : ''}`);
      } catch (e: any) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        // The docs pass already succeeded; say so rather than branding the whole ingest failed.
        await finish('done', `docs: ${queuedChapters} queued${linkNote} — exercise authoring failed: ${msg}`);
      }
    } catch (e: any) {
      await finish('error', 'repo ingest failed', (e instanceof Error ? e.message : String(e)).slice(0, 500));
    }
  })();

  return { name, ingesting: true };
}
