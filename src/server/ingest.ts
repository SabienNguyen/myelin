import { ToolLoopAgent, isStepCount, type LanguageModel, type ToolSet } from 'ai';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessConfig } from './config.js';
import {
  cleanHeading, defaultConverter, defaultIncrementalConverter, splitChapters, type Converter, type IncrementalConverter,
} from './convert.js';
import type { Loreweaver } from './mcp.js';
import { modelFor } from './models.js';
import { sanitizeToolArgs } from './session.js';

const here = dirname(fileURLToPath(import.meta.url));

export type QueueStatus = 'converting' | 'convert-error' | 'pending' | 'compiling' | 'done' | 'error';
export interface QueueEntry {
  book: string;
  chapter: string; // vault-relative path, e.g. 'raw/uploads/<book-slug>/ch-01-....md'
  title: string;
  status: QueueStatus;
  error?: string;
  startedAt?: string; // ISO — set on 'converting' placeholders so the UI can show elapsed time
  progress?: { pagesDone: number; pagesTotal: number | null }; // set on 'converting' placeholders
}

// Mirrors loreweaver's src/vault/parsePage.ts slugify — duplicated here for the same reason
// DECAY/MasteryLevel are duplicated in src/shared/loreweaver.ts (documented divergence risk).
function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function ledgerPath(vault: string): string {
  return join(vault, '.harness', 'compile-queue.json');
}

/** The full compile queue ledger — used by the ingest REST routes and by tests. */
export function readQueue(vault: string): QueueEntry[] {
  const p = ledgerPath(vault);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as QueueEntry[]) : [];
}

function writeQueue(vault: string, ledger: QueueEntry[]): void {
  mkdirSync(join(vault, '.harness'), { recursive: true });
  writeFileSync(ledgerPath(vault), JSON.stringify(ledger, null, 2));
}

const H1_LINE = /^#\s+(.+)$/m;

/**
 * Converts a book (or paper) file and appends 'pending' ledger entries to
 * vault/.harness/compile-queue.json. These are the only two locations this pipeline ever writes —
 * pages/ and students/ are the Loreweaver MCP server's exclusive territory.
 *
 * Book mode (default) splits the converted markdown into per-chapter files under
 * vault/raw/uploads/<book-slug>/ and appends one ledger entry per chapter.
 *
 * Paper mode writes the WHOLE converted markdown as a single vault/raw/uploads/<slug>/paper.md
 * (no chapter splitting — a paper is one unit of work) and appends exactly one ledger entry,
 * titled from `opts.title`, else the markdown's first H1 (heading text, '#' stripped), else the
 * filename.
 */
export async function ingestBook(
  cfg: HarnessConfig, filePath: string,
  opts: { converter?: Converter; mode?: 'book' | 'paper'; title?: string } = {},
): Promise<{ book: string; chapters: number }> {
  const converter = opts.converter ?? defaultConverter;
  const mode = opts.mode ?? 'book';
  const outDir = mkdtempSync(join(tmpdir(), 'lwh-convert-'));
  const { markdown } = await converter(filePath, outDir);
  const ledger = readQueue(cfg.vault);

  if (mode === 'paper') {
    const title = opts.title || cleanHeading(markdown.match(H1_LINE)?.[1] ?? '') || basename(filePath, extname(filePath));
    const slug = slugify(title) || 'paper';
    const uploadsDir = join(cfg.vault, 'raw', 'uploads', slug);
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, 'paper.md'), `<!-- source: "${title}" -->\n\n${markdown}\n`);
    ledger.push({
      book: title,
      chapter: `raw/uploads/${slug}/paper.md`,
      title,
      status: 'pending',
    });
    writeQueue(cfg.vault, ledger);
    return { book: title, chapters: 1 };
  }

  const bookTitle = basename(filePath, extname(filePath));
  const bookSlug = slugify(bookTitle) || 'book';
  const uploadsDir = join(cfg.vault, 'raw', 'uploads', bookSlug);
  mkdirSync(uploadsDir, { recursive: true });

  const chapters = splitChapters(markdown);
  chapters.forEach((ch, i) => {
    const n = i + 1;
    const chapterSlug = slugify(ch.title) || `chapter-${n}`;
    const filename = `ch-${String(n).padStart(2, '0')}-${chapterSlug}.md`;
    const header = `<!-- source: "${bookTitle}", chapter ${n}: "${ch.title}" -->\n\n`;
    writeFileSync(join(uploadsDir, filename), `${header}${ch.body}\n`);
    ledger.push({
      book: bookTitle,
      chapter: `raw/uploads/${bookSlug}/${filename}`,
      title: ch.title,
      status: 'pending',
    });
  });
  writeQueue(cfg.vault, ledger);

  return { book: bookTitle, chapters: chapters.length };
}

/** Incremented/decremented around every in-flight startConversion — marker owns the GPU while a
 * conversion is running, so ensureCompileDrain uses this to avoid contending with it for an
 * ollama-backed compile model (see canCompileNow). Module-level by design: one process, one GPU. */
let activeConversions = 0;

/** Wraps a plain (non-incremental) Converter into a single-shot IncrementalConverter — used when
 * a caller (or a test) injects opts.converter instead of opts.incrementalConverter. Exactly one
 * onProgress call, final=true, pagesTotal null (matches the "unknown page count" fallback path
 * of defaultIncrementalConverter). */
function singleShotIncremental(converter: Converter): IncrementalConverter {
  return async (file, outDir, onProgress) => {
    const { markdown } = await converter(file, outDir);
    await onProgress({ markdown, pagesDone: 0, pagesTotal: null, final: true });
  };
}

/**
 * Reload-safe async conversion: immediately writes a 'converting' placeholder to the ledger
 * (so the Library shows the book the moment it's uploaded, and a page reload still sees it),
 * then converts in the background, streaming progress into that placeholder.
 *
 * Book mode queues chapters PROGRESSIVELY as the incremental converter's cumulative markdown
 * confirms them complete (every split section except a still-growing last one, unless the final
 * update, when all remaining sections are complete) — so the Library fills in while a big scan is
 * still converting, rather than only at the very end. Paper mode keeps its original single-entry
 * behavior (no progressive splitting — a paper is one unit of work) but still streams progress
 * onto the placeholder.
 *
 * On completion the placeholder is removed, opts.onComplete fires, and — when cfg.autoCompile is
 * not explicitly false — ensureCompileDrain is kicked so newly-pending chapters start compiling
 * without a manual "Compile now" click. On failure the placeholder becomes 'convert-error' with
 * the message. Returns as soon as the placeholder is queued.
 */
export function startConversion(
  lw: Loreweaver, cfg: HarnessConfig, filePath: string,
  opts: {
    converter?: Converter; incrementalConverter?: IncrementalConverter;
    mode?: 'book' | 'paper'; title?: string; model?: LanguageModel; onComplete?: () => void;
  } = {},
): { book: string; converting: true } {
  const book = opts.title || basename(filePath, extname(filePath));
  const mode = opts.mode ?? 'book';
  const placeholderKey = `__converting__/${Date.now().toString(36)}`;
  const ledger = readQueue(cfg.vault);
  ledger.push({
    book, chapter: placeholderKey, title: 'Converting…',
    status: 'converting', startedAt: new Date().toISOString(),
  });
  writeQueue(cfg.vault, ledger);

  const incremental = opts.incrementalConverter ?? singleShotIncremental(opts.converter ?? defaultConverter);

  const bookTitle = basename(filePath, extname(filePath));
  const bookSlug = slugify(bookTitle) || 'book';
  const uploadsDir = join(cfg.vault, 'raw', 'uploads', bookSlug);

  function updatePlaceholderProgress(pagesDone: number, pagesTotal: number | null): void {
    const current = readQueue(cfg.vault);
    const ph = current.find((e) => e.chapter === placeholderKey);
    if (ph) {
      ph.progress = { pagesDone, pagesTotal };
      writeQueue(cfg.vault, current);
    }
  }

  activeConversions++;
  void (async () => {
    try {
      const outDir = mkdtempSync(join(tmpdir(), 'lwh-convert-'));

      if (mode === 'paper') {
        let lastMarkdown = '';
        await incremental(filePath, outDir, (u) => {
          lastMarkdown = u.markdown;
          updatePlaceholderProgress(u.pagesDone, u.pagesTotal);
        });
        const title = opts.title || lastMarkdown.match(H1_LINE)?.[1]?.trim() || basename(filePath, extname(filePath));
        const slug = slugify(title) || 'paper';
        const dir = join(cfg.vault, 'raw', 'uploads', slug);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'paper.md'), `<!-- source: "${title}" -->\n\n${lastMarkdown}\n`);

        const afterPaper = readQueue(cfg.vault).filter((e) => e.chapter !== placeholderKey);
        afterPaper.push({
          book: title, chapter: `raw/uploads/${slug}/paper.md`, title, status: 'pending',
        });
        writeQueue(cfg.vault, afterPaper);
      } else {
        mkdirSync(uploadsDir, { recursive: true });
        let queuedCount = 0;

        await incremental(filePath, outDir, (u) => {
          const sections = splitChapters(u.markdown);
          // A chapter is "complete" once a later heading confirms nothing more will be appended
          // under it — every section except the last, unless this is the final update (then the
          // last section is complete too; there's nothing left to grow it).
          const completeSections = u.final ? sections : sections.slice(0, -1);
          const newSections = completeSections.slice(queuedCount);

          const current = readQueue(cfg.vault);
          for (let i = 0; i < newSections.length; i++) {
            const ch = newSections[i];
            const n = queuedCount + i + 1;
            const chapterSlug = slugify(ch.title) || `chapter-${n}`;
            const filename = `ch-${String(n).padStart(2, '0')}-${chapterSlug}.md`;
            const header = `<!-- source: "${bookTitle}", chapter ${n}: "${ch.title}" -->\n\n`;
            writeFileSync(join(uploadsDir, filename), `${header}${ch.body}\n`);
            current.push({
              book: bookTitle, chapter: `raw/uploads/${bookSlug}/${filename}`, title: ch.title, status: 'pending',
            });
          }
          queuedCount += newSections.length;

          const ph = current.find((e) => e.chapter === placeholderKey);
          if (ph) ph.progress = { pagesDone: u.pagesDone, pagesTotal: u.pagesTotal };
          writeQueue(cfg.vault, current);
        });
      }

      const afterAll = readQueue(cfg.vault);
      writeQueue(cfg.vault, afterAll.filter((e) => e.chapter !== placeholderKey));
      opts.onComplete?.();
      if (cfg.autoCompile !== false) ensureCompileDrain(lw, cfg, { model: opts.model });
    } catch (e: any) {
      const after = readQueue(cfg.vault);
      const ph = after.find((en) => en.chapter === placeholderKey);
      if (ph) {
        ph.status = 'convert-error';
        ph.error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        writeQueue(cfg.vault, after);
      }
    } finally {
      activeConversions--;
    }
  })();

  return { book, converting: true };
}

/** Boot-time sweep: a server restart orphans in-flight conversions — mark them honestly. */
export function sweepInterruptedConversions(vault: string): number {
  const ledger = readQueue(vault);
  let swept = 0;
  for (const e of ledger) {
    if (e.status === 'converting') {
      e.status = 'convert-error';
      e.error = 'interrupted by a server restart — re-upload the file';
      swept++;
    }
  }
  if (swept) writeQueue(vault, ledger);
  return swept;
}

/** Rename a book across its queue entries (display name + future compile citations only —
 * the raw/uploads/<slug>/ folder keeps its original slug; files are inputs, not identity). */
export function renameBook(vault: string, from: string, to: string): number {
  const name = to.trim();
  if (!name) throw new Error('new name must not be empty');
  const ledger = readQueue(vault);
  let changed = 0;
  for (const e of ledger) if (e.book === from) { e.book = name; changed++; }
  if (changed) writeQueue(vault, ledger);
  return changed;
}

/** Wrap MCP tools so every execute() sees sanitized args, mirroring session.ts's guardMcpTools —
 * duplicated locally (not imported) because it's the ingest pipeline's own small guard, and
 * session.ts doesn't export the wrapper itself, only the sanitizeToolArgs primitive it's built on. */
function guardTools(tools: ToolSet, student: string, knownSlugs: string[]): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, t]: [string, any]) => [name, {
    ...t,
    execute: t.execute
      ? async (args: any, execOpts: any) => t.execute(sanitizeToolArgs(args, name, student, knownSlugs), execOpts)
      : t.execute,
  }])) as ToolSet;
}

let cachedPrompt: string | null = null;
function compileInstructions(): string {
  cachedPrompt ??= readFileSync(join(here, 'compile-prompt.md'), 'utf8');
  return cachedPrompt;
}

function buildCompilePrompt(
  bookTitle: string, chapterN: number, chapterTitle: string, chapterMarkdown: string, existingSlugs: string[],
): string {
  return [
    compileInstructions(),
    `Book: "${bookTitle}"`,
    `Chapter ${chapterN}: "${chapterTitle}"`,
    `Existing vault slugs (the ONLY valid slugs for prereqs/deepens/links besides ones you write in `
      + `this batch): ${existingSlugs.join(', ') || '(none yet)'}`,
    'Chapter content (markdown):',
    '"""',
    chapterMarkdown,
    '"""',
  ].join('\n\n');
}

/**
 * Compiles one 'pending' ledger entry (already claimed — status flipped to 'compiling' by the
 * caller) through a one-shot compile agent, passing the chapter markdown inline (never globbing
 * the vault). Mutates `entry` in place and writes the WHOLE ledger array to disk when done — safe
 * to call from multiple concurrent workers sharing the same in-memory `ledger` array, since each
 * worker only ever mutates its own claimed entry's fields and writeQueue is a synchronous
 * writeFileSync (no interleaved partial writes).
 */
async function compileOne(
  lw: Loreweaver, cfg: HarnessConfig, model: LanguageModel, ledger: QueueEntry[], entry: QueueEntry,
): Promise<'compiled' | 'failed'> {
  try {
    const chapterMarkdown = readFileSync(join(cfg.vault, entry.chapter), 'utf8');
    const slugs = await lw.listSlugs();
    const tools = guardTools(await lw.tools(), cfg.student, slugs);
    const chapterN = Number(entry.chapter.match(/ch-(\d+)-/)?.[1] ?? 1);

    const agent = new ToolLoopAgent({
      model,
      instructions: 'You are compiling one textbook chapter into Loreweaver vault pages.',
      tools,
      stopWhen: isStepCount(16),
    });

    const result = await agent.generate({
      prompt: buildCompilePrompt(entry.book, chapterN, entry.title, chapterMarkdown, slugs),
    });

    // "The agent finished" is not "the work happened" — small models sometimes narrate instead of
    // calling tools. Gate on THIS entry's own agent steps, not a global before/after vault-slug
    // diff: with concurrent workers compiling different chapters at once, a global diff would
    // attribute another worker's newly-written pages to this entry (a false "done"), or blame this
    // entry for pages another worker is mid-write on (a false "no pages"). Checking this agent's
    // own result.steps for a write_page tool call is per-entry accurate regardless of what any
    // other worker is doing concurrently.
    const wrotePage = result.steps.some((step) => step.toolCalls.some((tc) => tc.toolName === 'write_page'));
    if (!wrotePage) {
      throw new Error('model produced no pages (no write_page calls) — try a stronger compile model');
    }

    entry.status = 'done';
    return 'compiled';
  } catch (e: any) {
    entry.status = 'error';
    entry.error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    return 'failed';
  } finally {
    writeQueue(cfg.vault, ledger);
  }
}

/**
 * Takes the next `n` 'pending' ledger entries and compiles them, `opts.concurrency` at a time (a
 * simple worker-pool over the batch — no extra dependency). Each worker repeatedly claims the next
 * unclaimed entry from `batch` via `claimNext`, whose cursor-bump + status flip + ledger write runs
 * fully synchronously (no `await` before it returns) so concurrent workers can never claim the same
 * entry twice, even though they call it through `await`. Ledger writes stay per-entry and
 * crash-safe (see compileOne); the honesty gate stays per-entry accurate under concurrency (see
 * compileOne's comment).
 */
export async function compileNext(
  lw: Loreweaver, cfg: HarnessConfig, n = 1, opts: { model?: LanguageModel; concurrency?: number } = {},
): Promise<{ compiled: number; failed: number }> {
  const model = opts.model ?? modelFor('compile', cfg);
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const ledger = readQueue(cfg.vault);
  const batch = ledger.filter((e) => e.status === 'pending').slice(0, n);

  let compiled = 0;
  let failed = 0;
  let cursor = 0;

  function claimNext(): QueueEntry | undefined {
    if (cursor >= batch.length) return undefined;
    const entry = batch[cursor++];
    entry.status = 'compiling';
    writeQueue(cfg.vault, ledger);
    return entry;
  }

  async function worker(): Promise<void> {
    for (;;) {
      const entry = claimNext();
      if (!entry) return;
      const outcome = await compileOne(lw, cfg, model, ledger, entry);
      if (outcome === 'compiled') compiled++; else failed++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, () => worker()));

  return { compiled, failed };
}

const OLLAMA_PREFIX = 'ollama:';
const DRAIN_GPU_CONTENTION_BACKOFF_MS = 5_000;

/**
 * Pure gate for ensureCompileDrain: an ollama-backed compile model shares the GPU with marker —
 * running both at once is a guaranteed CUDA OOM (see convert.ts's freeOllamaVram comment). Cloud
 * models (anthropic, etc.) never contend for the local GPU, so they're always cleared to run.
 */
export function canCompileNow(compileModelId: string, conversionsActive: number): boolean {
  return !(compileModelId.startsWith(OLLAMA_PREFIX) && conversionsActive > 0);
}

/**
 * Pure gate for how many chapters ensureCompileDrain compiles at once. Same GPU-contention
 * reasoning as canCompileNow: an ollama-backed compile model shares the one local GPU with marker
 * (and with itself — running several ollama generations at once against one GPU just serializes
 * anyway and risks the same OOM canCompileNow already guards against), so it stays strictly
 * sequential. A cloud compile model has no local GPU to contend for, so several chapters can
 * compile in parallel — 4 is a modest default (bounded by provider rate limits, not local
 * resources).
 */
export function compileConcurrencyFor(compileModelId: string): number {
  return compileModelId.startsWith(OLLAMA_PREFIX) ? 1 : 4;
}

let drainRunning = false;

/**
 * Drains the 'pending' queue by repeatedly calling compileNext(lw, cfg, concurrency, opts) until
 * nothing is pending, where concurrency comes from compileConcurrencyFor(compileModelId).
 * Module-singleton (drainRunning) — safe to call from multiple places (startConversion on
 * completion, ingestTools' ingest_paper tool, index.ts at boot) without stacking concurrent drains.
 * When the compile model is ollama-backed and a conversion is actively running, backs off
 * DRAIN_GPU_CONTENTION_BACKOFF_MS and rechecks rather than contending with marker for the GPU — a
 * non-ollama (cloud) compile model has no such restriction and can drain while a conversion is
 * still in flight (canCompileNow already allows that; compileDrain.test.ts's "cloud model can
 * compile during an active conversion" case exercises it end to end). Entries that error stay
 * 'error' — the loop moves on and never retries a failed one (manual retry only, e.g. re-running
 * compile from the UI later).
 */
export function ensureCompileDrain(lw: Loreweaver, cfg: HarnessConfig, opts: { model?: LanguageModel } = {}): void {
  if (drainRunning) return;
  // Defensive: production config always has models.compile (zod-required), but some test
  // fixtures construct a bare-bones HarnessConfig without it — treat that as "nothing to drain"
  // rather than throwing out of a fire-and-forget background loop.
  const compileModelId = cfg.models?.compile?.model;
  if (!compileModelId) return;

  drainRunning = true;
  void (async () => {
    try {
      const concurrency = compileConcurrencyFor(compileModelId);
      while (readQueue(cfg.vault).some((e) => e.status === 'pending')) {
        if (!canCompileNow(compileModelId, activeConversions)) {
          await new Promise((r) => { setTimeout(r, DRAIN_GPU_CONTENTION_BACKOFF_MS); });
          continue;
        }
        await compileNext(lw, cfg, concurrency, { ...opts, concurrency });
      }
    } catch (e) {
      console.error('[ensureCompileDrain]', e);
    } finally {
      drainRunning = false;
    }
  })();
}
