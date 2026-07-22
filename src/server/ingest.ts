import { ToolLoopAgent, isStepCount, type LanguageModel, type ToolSet } from 'ai';
import {
  mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeSdkGenerate, isClaudeSdkModel, stripClaudeSdkPrefix } from './claudeSdk.js';
import type { HarnessConfig } from './config.js';
import {
  cleanHeading, defaultConverter, defaultIncrementalConverter, splitChapters, type Converter, type IncrementalConverter,
} from './convert.js';
import type { Loreweaver } from './mcp.js';
import { modelFor } from './models.js';
import {
  readQueue, updateQueue, writeQueue, type QueueEntry, type QueueStatus,
} from './queueStore.js';
import { sanitizeToolArgs } from './session.js';

/** Injectable seam for tests — see claudeSdk.ts. */
export interface CompileDeps {
  sdkGenerate?: typeof claudeSdkGenerate;
}

const here = dirname(fileURLToPath(import.meta.url));

// The ledger's storage primitives (readQueue/writeQueue/updateQueue) and its entry shape now live
// in queueStore.ts — re-exported here so every existing import of `readQueue`/`writeQueue`/
// `QueueEntry`/`QueueStatus` from './ingest.js' keeps working unchanged. See queueStore.ts's module
// doc comment for the full incident writeup this split is in service of: production code must
// mutate the ledger only via updateQueue, never via a hand-rolled readQueue-then-writeQueue pair.
export {
  readQueue, writeQueue, type QueueEntry, type QueueStatus,
} from './queueStore.js';

// Mirrors loreweaver's src/vault/parsePage.ts slugify — duplicated here for the same reason
// DECAY/MasteryLevel are duplicated in src/shared/loreweaver.ts (documented divergence risk).
// Exported for ingestRepo.ts, which needs the identical slug algorithm for repo/doc-file naming.
export function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
  opts: { converter?: Converter; mode?: 'book' | 'paper'; title?: string; sourceUrl?: string } = {},
): Promise<{ book: string; chapters: number }> {
  const converter = opts.converter ?? defaultConverter;
  const mode = opts.mode ?? 'book';
  const outDir = mkdtempSync(join(tmpdir(), 'lwh-convert-'));
  const { markdown } = await converter(filePath, outDir);

  if (mode === 'paper') {
    const title = opts.title || cleanHeading(markdown.match(H1_LINE)?.[1] ?? '') || basename(filePath, extname(filePath));
    const slug = slugify(title) || 'paper';
    const uploadsDir = join(cfg.vault, 'raw', 'uploads', slug);
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, 'paper.md'), `<!-- source: "${title}" -->\n\n${markdown}\n`);
    await updateQueue(cfg.vault, (entries) => {
      entries.push({
        book: title,
        chapter: `raw/uploads/${slug}/paper.md`,
        title,
        status: 'pending',
        ...(opts.sourceUrl ? { sourceUrl: opts.sourceUrl } : {}),
      });
    });
    return { book: title, chapters: 1 };
  }

  const bookTitle = basename(filePath, extname(filePath));
  const bookSlug = slugify(bookTitle) || 'book';
  const uploadsDir = join(cfg.vault, 'raw', 'uploads', bookSlug);
  mkdirSync(uploadsDir, { recursive: true });

  const chapters = splitChapters(markdown);
  const newEntries: QueueEntry[] = chapters.map((ch, i) => {
    const n = i + 1;
    const chapterSlug = slugify(ch.title) || `chapter-${n}`;
    const filename = `ch-${String(n).padStart(2, '0')}-${chapterSlug}.md`;
    const header = `<!-- source: "${bookTitle}", chapter ${n}: "${ch.title}" -->\n\n`;
    writeFileSync(join(uploadsDir, filename), `${header}${ch.body}\n`);
    return {
      book: bookTitle,
      chapter: `raw/uploads/${bookSlug}/${filename}`,
      title: ch.title,
      status: 'pending' as const,
    };
  });
  await updateQueue(cfg.vault, (entries) => { entries.push(...newEntries); });

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
 *
 * Ledger-write note: the INITIAL placeholder push just below is a direct readQueue+writeQueue pair,
 * not routed through updateQueue's async mutex — deliberately, because this function's contract is
 * "returns as soon as the placeholder is queued": callers (the upload/URL ingest routes,
 * ingest_paper) read the ledger synchronously right after this call returns and expect the
 * placeholder to already be durable on disk, not landing on a later microtask. That's safe because
 * nothing async happens between this read and this write (see queueStore.ts's module doc for why
 * that's the only condition that matters). Every OTHER write below — all in the background
 * continuation, arbitrarily far past an await — goes through updateQueue.
 */
export function startConversion(
  lw: Loreweaver, cfg: HarnessConfig, filePath: string,
  opts: {
    converter?: Converter; incrementalConverter?: IncrementalConverter;
    mode?: 'book' | 'paper'; title?: string; sourceUrl?: string; model?: LanguageModel; onComplete?: () => void;
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

  async function updatePlaceholderProgress(pagesDone: number, pagesTotal: number | null): Promise<void> {
    await updateQueue(cfg.vault, (entries) => {
      const ph = entries.find((e) => e.chapter === placeholderKey);
      if (ph) ph.progress = { pagesDone, pagesTotal };
    });
  }

  activeConversions++;
  void (async () => {
    try {
      const outDir = mkdtempSync(join(tmpdir(), 'lwh-convert-'));

      if (mode === 'paper') {
        let lastMarkdown = '';
        await incremental(filePath, outDir, async (u) => {
          lastMarkdown = u.markdown;
          await updatePlaceholderProgress(u.pagesDone, u.pagesTotal);
        });
        const title = opts.title || lastMarkdown.match(H1_LINE)?.[1]?.trim() || basename(filePath, extname(filePath));
        const slug = slugify(title) || 'paper';
        const dir = join(cfg.vault, 'raw', 'uploads', slug);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'paper.md'), `<!-- source: "${title}" -->\n\n${lastMarkdown}\n`);

        await updateQueue(cfg.vault, (entries) => {
          const kept = entries.filter((e) => e.chapter !== placeholderKey);
          kept.push({
            book: title, chapter: `raw/uploads/${slug}/paper.md`, title, status: 'pending',
          });
          return kept;
        });
      } else {
        mkdirSync(uploadsDir, { recursive: true });
        let queuedCount = 0;

        await incremental(filePath, outDir, async (u) => {
          const sections = splitChapters(u.markdown);
          // A chapter is "complete" once a later heading confirms nothing more will be appended
          // under it — every section except the last, unless this is the final update (then the
          // last section is complete too; there's nothing left to grow it).
          const completeSections = u.final ? sections : sections.slice(0, -1);
          const newSections = completeSections.slice(queuedCount);

          const newEntries: QueueEntry[] = newSections.map((ch, i) => {
            const n = queuedCount + i + 1;
            const chapterSlug = slugify(ch.title) || `chapter-${n}`;
            const filename = `ch-${String(n).padStart(2, '0')}-${chapterSlug}.md`;
            const header = `<!-- source: "${bookTitle}", chapter ${n}: "${ch.title}" -->\n\n`;
            writeFileSync(join(uploadsDir, filename), `${header}${ch.body}\n`);
            return {
              book: bookTitle, chapter: `raw/uploads/${bookSlug}/${filename}`, title: ch.title, status: 'pending' as const,
            };
          });
          queuedCount += newSections.length;

          await updateQueue(cfg.vault, (entries) => {
            entries.push(...newEntries);
            const ph = entries.find((e) => e.chapter === placeholderKey);
            if (ph) ph.progress = { pagesDone: u.pagesDone, pagesTotal: u.pagesTotal };
          });
        });
      }

      await updateQueue(cfg.vault, (entries) => entries.filter((e) => e.chapter !== placeholderKey));
      opts.onComplete?.();
      if (cfg.autoCompile !== false) ensureCompileDrain(lw, cfg, { model: opts.model });
    } catch (e: any) {
      await updateQueue(cfg.vault, (entries) => {
        const ph = entries.find((en) => en.chapter === placeholderKey);
        if (ph) {
          ph.status = 'convert-error';
          ph.error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        }
      });
    } finally {
      activeConversions--;
    }
  })();

  return { book, converting: true };
}

/** Boot-time sweep: a server restart orphans in-flight work — handle both kinds honestly.
 * Conversions can't resume (the tmp upload is process-tied) -> convert-error, re-upload.
 * Compiles CAN resume (chapter file + ledger persist; write_page updates in place) -> back
 * to pending so the boot drain picks them up.
 *
 * Stays a direct readQueue+writeQueue pair (not updateQueue) rather than the async mutex: it's
 * called synchronously at boot (src/server/index.ts, not awaited) and its own tests call it
 * synchronously too, so its signature has to stay `(vault) => number`. That's fine — this function
 * never holds anything across an await (read, synchronous loop, write, done), so it can't reproduce
 * the lost-update bug updateQueue exists to close; see queueStore.ts's module doc comment. */
export function sweepInterruptedConversions(vault: string): number {
  const ledger = readQueue(vault);
  let swept = 0;
  for (const e of ledger) {
    if (e.status === 'converting') {
      e.status = 'convert-error';
      e.error = e.mode === 'repo'
        ? 'interrupted by a server restart — re-run the repo ingest'
        : 'interrupted by a server restart — re-upload the file';
      swept++;
    } else if (e.status === 'compiling') {
      e.status = 'pending';
      delete e.error;
      swept++;
    }
  }
  if (swept) writeQueue(vault, ledger);
  return swept;
}

/** Rename a book across its queue entries (display name + future compile citations only —
 * the raw/uploads/<slug>/ folder keeps its original slug; files are inputs, not identity).
 *
 * Stays a direct readQueue+writeQueue pair for the same reason sweepInterruptedConversions does:
 * its only call site (ingestRoutes.ts's PATCH /api/ingest/book) uses the return value synchronously
 * (`renameBook(...) === 0` decides the 404 branch), so the signature has to stay `(...) => number`,
 * not `Promise<number>`. Safe for the same reason — no await between its read and its write. */
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

/** Local 32k-context models + ollama's silent head-truncation on overflow = the compile
 * instructions vanish and the model chats instead of tool-calling (observed live: 66-page Murphy
 * chapters). Chapters over this char budget compile in sequential parts; each part refreshes the
 * vault slug list so later parts link pages written by earlier ones. ~3.5 chars/token → ~7k
 * tokens of chapter per part, leaving room for instructions, slugs, and tool-call output. */
export const CHAPTER_CHUNK_CHARS = 24_000;

export function chunkChapter(markdown: string, budget = CHAPTER_CHUNK_CHARS): string[] {
  if (markdown.length <= budget) return [markdown];
  const sections = markdown.split(/^(?=##\s)/m); // keep each H2 heading with its section body
  const parts: string[] = [];
  let cur = '';
  const flush = () => { if (cur.trim()) parts.push(cur); cur = ''; };
  for (const section of sections) {
    if (cur && cur.length + section.length > budget) flush();
    if (section.length > budget) {
      // one giant section: hard-cut at paragraph boundaries near the budget
      let rest = cur + section;
      cur = '';
      while (rest.length > budget) {
        let cut = rest.lastIndexOf('\n\n', budget);
        if (cut < budget * 0.5) cut = budget;
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      cur = rest;
    } else {
      cur += section;
    }
  }
  flush();
  return parts;
}

function buildCompilePrompt(
  bookTitle: string, chapterN: number, chapterTitle: string, chapterMarkdown: string, existingSlugs: string[],
  partLabel = '',
): string {
  return [
    compileInstructions(),
    `Book: "${bookTitle}"`,
    `Chapter ${chapterN}: "${chapterTitle}"${partLabel}`,
    `Existing vault slugs (the ONLY valid slugs for prereqs/deepens/links besides ones you write in `
      + `this batch): ${existingSlugs.join(', ') || '(none yet)'}`,
    'Chapter content (markdown):',
    '"""',
    chapterMarkdown,
    '"""',
  ].join('\n\n');
}

/**
 * Compiles one 'pending' (now 'compiling', flipped by the caller's claimNext) ledger entry through
 * a one-shot compile agent, passing the chapter markdown inline (never globbing the vault).
 *
 * Ledger-write note: `entry`'s book/chapter/title/sourceUrl fields are read-only snapshots taken at
 * claim time — this function never mutates them and never holds/writes the whole ledger array.
 * Instead, its `finally` block patches ONLY this entry's status/error, by looking it up fresh by
 * `entry.chapter` identity via updateQueue — a targeted, re-read-inside-the-mutex write, not a
 * stale whole-array one. THIS is the fix for the lost-update bug: the old version wrote back a
 * `ledger` array that compileNext had read once, BEFORE this function's (potentially long, LLM-
 * call-laden) awaits above — any row another flow appended to the file during that window was
 * invisible to that stale array and got clobbered the instant this finally block fired. See
 * queueStore.ts's module doc comment for the full incident writeup.
 */
async function compileOne(
  lw: Loreweaver, cfg: HarnessConfig, model: LanguageModel | undefined, entry: QueueEntry,
  chunkChars: number,
  claudeSdk: { useSdk: boolean; modelId: string; deps?: CompileDeps },
): Promise<'compiled' | 'failed'> {
  let status: QueueStatus = 'done';
  let error: string | undefined;
  try {
    const chapterMarkdown = readFileSync(join(cfg.vault, entry.chapter), 'utf8');
    const chapterN = Number(entry.chapter.match(/ch-(\d+)-/)?.[1] ?? 1);
    const chunks = chunkChapter(chapterMarkdown, chunkChars);

    // Citation is a MECHANICAL guarantee on the ai-sdk path, not a prompt hope: every write_page
    // during this compile gets the canonical source merged into its sources array, whether or not
    // the model remembered. Papers cite their fetch URL; book chapters cite book + chapter.
    const citation = entry.sourceUrl
      ? `${entry.book} (${entry.sourceUrl})`
      : `${entry.book} — ${entry.title}`;
    const withCitation = (tools: ToolSet): ToolSet =>
      Object.fromEntries(Object.entries(tools).map(([name, t]: [string, any]) => [name, name !== 'write_page' ? t : {
        ...t,
        execute: t.execute
          ? (args: any, execOpts: any) => t.execute({
            ...args,
            sources: [...new Set([...(Array.isArray(args?.sources) ? args.sources : []), citation])],
          }, execOpts)
          : t.execute,
      }])) as ToolSet;

    let wroteAny = false;
    const partErrors: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      // Refresh slugs per part: part 2's prereq/link candidates include part 1's new pages.
      const slugs = await lw.listSlugs();
      const partLabel = chunks.length > 1 ? ` (part ${i + 1} of ${chunks.length})` : '';
      const prompt = buildCompilePrompt(entry.book, chapterN, entry.title, chunks[i], slugs, partLabel);

      if (claudeSdk.useSdk) {
        // The Agent SDK path can't wrap tool execute() the way withCitation does above, so the
        // citation guarantee here is a prompt instruction, not a mechanical one — a known gap
        // (documented in T40's commit message).
        const sdkGenerate = claudeSdk.deps?.sdkGenerate ?? claudeSdkGenerate;
        try {
          const { toolCallNames } = await sdkGenerate({
            model: stripClaudeSdkPrefix(claudeSdk.modelId),
            prompt: `${prompt}\n\nREQUIRED: every write_page call's "sources" array MUST include `
              + `exactly this string: "${citation}".`,
            mcp: {
              loreweaver: {
                command: cfg.loreweaver.command,
                args: cfg.loreweaver.args,
                // Mirrors mcp.ts's Loreweaver.spawn env exactly. NOTE: this spawns a SECOND
                // loreweaver server process pointed at the same vault — loreweaver's writes are
                // file-per-page, and the harness's own client (`lw`) only calls listSlugs()
                // (a filesystem glob) during compile, never lw.tools()/lw.call(), so a second
                // writer process here is acceptable for now.
                env: {
                  ...process.env as Record<string, string>,
                  LOREWEAVER_VAULT: cfg.vault,
                  LOREWEAVER_EMBEDDINGS: cfg.loreweaver.embeddings,
                },
              },
            },
            allowedTools: ['mcp__loreweaver__write_page', 'mcp__loreweaver__link_pages', 'mcp__loreweaver__read_page'],
            maxTurns: 24,
          });
          // Same honesty gate as the ai-sdk path below, just fed from the SDK's own tool-call log
          // instead of ToolLoopAgent's step array.
          if (toolCallNames.includes('write_page')) wroteAny = true;
          else partErrors.push(`part ${i + 1}: no write_page calls`);
        } catch (partErr: any) {
          partErrors.push(`part ${i + 1}: ${(partErr instanceof Error ? partErr.message : String(partErr)).slice(0, 120)}`);
        }
        continue;
      }

      const tools = withCitation(guardTools(await lw.tools(), cfg.student, slugs));
      const agent = new ToolLoopAgent({
        model: model!, // invariant: useSdk is false here, so compileNext always supplied a model
        instructions: 'You are compiling one textbook chapter into Loreweaver vault pages.',
        tools,
        stopWhen: isStepCount(16),
      });
      try {
        const result = await agent.generate({ prompt });
        // "The agent finished" is not "the work happened" — small models sometimes narrate instead
        // of calling tools. Gate on THIS agent's own steps (per-entry AND per-part accurate under
        // concurrency; a global vault-slug diff would misattribute other workers' pages).
        const wrotePage = result.steps.some((step) => step.toolCalls.some((tc) => tc.toolName === 'write_page'));
        if (wrotePage) wroteAny = true;
        else partErrors.push(`part ${i + 1}: no write_page calls`);
      } catch (partErr: any) {
        partErrors.push(`part ${i + 1}: ${(partErr instanceof Error ? partErr.message : String(partErr)).slice(0, 120)}`);
      }
    }

    if (!wroteAny) {
      throw new Error(
        `model produced no pages (${partErrors.join('; ') || 'no write_page calls'}) — try a stronger compile model`,
      );
    }
    if (partErrors.length) console.error(`[compile] "${entry.title}": partial (${partErrors.join('; ')})`);

    status = 'done';
    return 'compiled';
  } catch (e: any) {
    status = 'error';
    error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    return 'failed';
  } finally {
    await updateQueue(cfg.vault, (entries) => {
      const live = entries.find((e) => e.chapter === entry.chapter);
      if (live) {
        live.status = status;
        if (error !== undefined) live.error = error;
      }
    });
  }
}

/**
 * Takes the next `n` 'pending' ledger entries and compiles them, `opts.concurrency` at a time (a
 * simple worker-pool over the batch — no extra dependency). `batch` is a one-time snapshot that
 * only decides WHICH n entries (by `chapter` identity) this call targets — it is never written
 * back. Each worker repeatedly claims the next unclaimed identity from `batch` via `claimNext`,
 * whose cursor bump (`batch[cursor++]`) runs fully synchronously before any await, so concurrent
 * workers can never claim the same entry twice; the actual status flip re-reads the ledger fresh
 * and patches only that one entry via updateQueue, so it can never clobber a row some other flow
 * (ingestRepo's docs pass, a concurrent startConversion) appended to the file while this batch's
 * compiles — each potentially a long LLM call — are in flight. compileOne's own finally block does
 * the same targeted-patch dance for the final status. See queueStore.ts's module doc comment for
 * the incident this replaces.
 */
export async function compileNext(
  lw: Loreweaver, cfg: HarnessConfig, n = 1,
  opts: { model?: LanguageModel; concurrency?: number; chunkChars?: number; deps?: CompileDeps } = {},
): Promise<{ compiled: number; failed: number }> {
  const compileModelId = cfg.models?.compile?.model;
  const useSdk = !!compileModelId && isClaudeSdkModel(compileModelId);
  // useSdk skips modelFor entirely — 'claude-sdk:...' is not a valid ai-sdk model id.
  const model = useSdk ? undefined : (opts.model ?? modelFor('compile', cfg));
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const snapshot = readQueue(cfg.vault);
  const batch = snapshot.filter((e) => e.status === 'pending').slice(0, n);

  let compiled = 0;
  let failed = 0;
  let cursor = 0;

  async function claimNext(): Promise<QueueEntry | undefined> {
    if (cursor >= batch.length) return undefined;
    const target = batch[cursor++]; // synchronous bump — no two workers ever get the same target
    let claimed: QueueEntry = target;
    await updateQueue(cfg.vault, (entries) => {
      const live = entries.find((e) => e.chapter === target.chapter);
      if (live) { live.status = 'compiling'; claimed = live; }
    });
    return claimed;
  }

  async function worker(): Promise<void> {
    for (;;) {
      const entry = await claimNext();
      if (!entry) return;
      const outcome = await compileOne(
        lw, cfg, model, entry, opts.chunkChars ?? CHAPTER_CHUNK_CHARS,
        { useSdk, modelId: compileModelId ?? '', deps: opts.deps },
      );
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
 * models — anthropic ids and claude-sdk: ids alike (the Agent SDK talks to Anthropic's servers,
 * not a local GPU) — never contend for the local GPU, so they're always cleared to run.
 */
export function canCompileNow(compileModelId: string, conversionsActive: number): boolean {
  return !(compileModelId.startsWith(OLLAMA_PREFIX) && conversionsActive > 0);
}

/**
 * Pure gate for how many chapters ensureCompileDrain compiles at once. Same GPU-contention
 * reasoning as canCompileNow: an ollama-backed compile model shares the one local GPU with marker
 * (and with itself — running several ollama generations at once against one GPU just serializes
 * anyway and risks the same OOM canCompileNow already guards against), so it stays strictly
 * sequential. A cloud compile model (anthropic or claude-sdk:) has no local GPU to contend for, so several chapters can
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
