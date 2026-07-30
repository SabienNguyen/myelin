import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessConfig } from './config.js';
import {
  cleanHeading, defaultConverter, defaultIncrementalConverter, maskFences, splitChapters,
  type Converter, type IncrementalConverter,
} from './convert.js';
import { extractProblems, saveProblems } from './courseBank.js';
import { analyzeLinkList, saveLinkDirectory } from './linkList.js';
import { runLoop, type ChatModel, type LoopTool } from './llm/index.js';
import type { Engram } from './mcp.js';
import { chatModelFor } from './models.js';
import {
  readQueue, updateQueue, writeQueue, type QueueEntry, type QueueStatus,
} from './queueStore.js';
import { sanitizeToolArgs, SLUG_LIST_CAP } from './session.js';
import { recordUsage } from './usageLedger.js';
import { isVideoUrl, linkifyTimestamps } from './videoIngest.js';

const here = dirname(fileURLToPath(import.meta.url));

// The ledger's storage primitives (readQueue/writeQueue/updateQueue) and its entry shape now live
// in queueStore.ts — re-exported here so every existing import of `readQueue`/`writeQueue`/
// `QueueEntry`/`QueueStatus` from './ingest.js' keeps working unchanged. See queueStore.ts's module
// doc comment for the full incident writeup this split is in service of: production code must
// mutate the ledger only via updateQueue, never via a hand-rolled readQueue-then-writeQueue pair.
export {
  readQueue, writeQueue, type QueueEntry, type QueueStatus,
} from './queueStore.js';

// Mirrors engram's src/vault/parsePage.ts slugify — duplicated here for the same reason
// DECAY/MasteryLevel are duplicated in src/shared/engram.ts (documented divergence risk).
// Exported for ingestRepo.ts, which needs the identical slug algorithm for repo/doc-file naming.
export function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const H1_LINE = /^#\s+(.+)$/m;

/**
 * Converts a book (or paper) file and appends 'pending' ledger entries to
 * vault/.harness/compile-queue.json. These are the only two locations this pipeline ever writes —
 * pages/ and students/ are the Engram MCP server's exclusive territory.
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
  // The converter writes the extracted markdown (and any assets it unpacks — pandoc/pdftotext leave
  // images and intermediate files) into outDir; nothing below needs it once `markdown` is in hand,
  // so remove it right after rather than leaking a /tmp/lwh-convert-* dir per ingest.
  let markdown: string;
  try {
    ({ markdown } = await converter(filePath, outDir));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

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
 * Problem sets and past exams take NEITHER path: when the converted markdown extracts as a
 * problem set (courseBank.ts's extractProblems), the problems are saved to the course bank
 * verbatim and the ledger records "N problems banked" — no compile entries are queued, because a
 * drilled exam must stay the professor's wording, not become prose pages.
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
  lw: Engram, cfg: HarnessConfig, filePath: string,
  opts: {
    converter?: Converter; incrementalConverter?: IncrementalConverter;
    mode?: 'book' | 'paper'; title?: string; sourceUrl?: string; model?: ChatModel; onComplete?: () => void;
    // A temp dir holding the INPUT file this conversion consumes. The upload/video/download routes
    // each create one per ingest (lwh-upload-/lwh-video-/lwh-download-) and hand it off here, because
    // the conversion runs in the background — past the route's return — so only this function knows
    // when the input has been fully read and the dir is safe to delete. Removed in the finally.
    // MUST stay unset for a learner's OWN local file path (ingestRoutes' `path` branch): its parent
    // is the user's directory, and deleting that would be catastrophic.
    cleanupInputDir?: string;
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

  // An injected plain Converter (tests, and callers that already have a single-shot conversion)
  // wraps into the one-shot shape; with NOTHING injected the real incremental converter runs.
  // The old expression here — `singleShotIncremental(opts.converter ?? defaultConverter)` — never
  // selected defaultIncrementalConverter at all, so production uploads silently lost progressive
  // chapter queueing and the page-count progress bar this function's doc comment promises.
  const incremental = opts.incrementalConverter
    ?? (opts.converter ? singleShotIncremental(opts.converter) : defaultIncrementalConverter);

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
    // Hoisted so the finally can remove it: the streaming converter uses it for the whole run.
    let outDir: string | undefined;
    try {
      outDir = mkdtempSync(join(tmpdir(), 'lwh-convert-'));
      // Set as soon as any cumulative markdown extracts as a problem set (courseBank.ts) — the
      // whole document then goes to the COURSE BANK, not the page-compile queue. A past exam
      // paraphrased into prose pages is the wrong shape; the student wants the professor's actual
      // problems, verbatim.
      let bankProblems: ReturnType<typeof extractProblems> | null = null;
      // Same diversion pattern for the third document shape this pipeline can be handed: a
      // link DIRECTORY (awesome-list — see linkList.ts). The repo docs pass already explodes
      // these; this is the same rule for the other two doors (a bare .md upload/local path, a
      // downloaded URL), so no door compiles a table of contents into pages. Re-evaluated on the
      // cumulative markdown every update, exactly like bankProblems — the final verdict decides.
      let linkCatalogue: ReturnType<typeof analyzeLinkList> | null = null;
      // Chapter identities this conversion queued before extraction tipped over MIN_PROBLEMS (a
      // sliced PDF can queue early chapters before enough of the exam has converted to recognize
      // it) — removed again when the document banks (or turns out to be a link directory).
      const queuedChapters: string[] = [];

      if (mode === 'paper') {
        let lastMarkdown = '';
        await incremental(filePath, outDir, async (u) => {
          lastMarkdown = u.markdown;
          await updatePlaceholderProgress(u.pagesDone, u.pagesTotal);
        });
        bankProblems = extractProblems(lastMarkdown);
        linkCatalogue = analyzeLinkList(lastMarkdown);
        const title = opts.title || lastMarkdown.match(H1_LINE)?.[1]?.trim() || basename(filePath, extname(filePath));
        const slug = slugify(title) || 'paper';
        const dir = join(cfg.vault, 'raw', 'uploads', slug);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'paper.md'), `<!-- source: "${title}" -->\n\n${lastMarkdown}\n`);

        if (bankProblems.length === 0 && !linkCatalogue.isLinkList) {
          await updateQueue(cfg.vault, (entries) => {
            const kept = entries.filter((e) => e.chapter !== placeholderKey);
            kept.push({
              book: title, chapter: `raw/uploads/${slug}/paper.md`, title, status: 'pending',
            });
            return kept;
          });
        }
      } else {
        mkdirSync(uploadsDir, { recursive: true });
        let queuedCount = 0;

        await incremental(filePath, outDir, async (u) => {
          linkCatalogue = analyzeLinkList(u.markdown);
          if (linkCatalogue.isLinkList) {
            // A link directory: keep the raw markdown for the record, queue nothing further. If a
            // later slice's prose tips the verdict back (re-evaluated on cumulative markdown, like
            // bankProblems), queuedCount hasn't advanced, so the next round queues every complete
            // section — nothing is lost by having skipped this one.
            writeFileSync(join(uploadsDir, 'source.md'), `<!-- source: "${bookTitle}" -->\n\n${u.markdown}\n`);
            await updatePlaceholderProgress(u.pagesDone, u.pagesTotal);
            return;
          }
          bankProblems = extractProblems(u.markdown);
          if (bankProblems.length > 0) {
            // A problem set: keep the raw markdown for the record, queue nothing further.
            writeFileSync(join(uploadsDir, 'source.md'), `<!-- source: "${bookTitle}" -->\n\n${u.markdown}\n`);
            await updatePlaceholderProgress(u.pagesDone, u.pagesTotal);
            return;
          }
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
          queuedChapters.push(...newEntries.map((e) => e.chapter));

          await updateQueue(cfg.vault, (entries) => {
            entries.push(...newEntries);
            const ph = entries.find((e) => e.chapter === placeholderKey);
            if (ph) ph.progress = { pagesDone: u.pagesDone, pagesTotal: u.pagesTotal };
          });
        });
      }

      // Link-directory diversion — the final verdict on the cumulative markdown, same terminal
      // shape as the course bank below: placeholder and any early-queued chapters come out, one
      // 'done' row records what happened, and the catalogue lands where the Library reads it
      // (GET /api/linklists). Checked before the bank: a directory that happened to trip the
      // problem extractor on an early slice is still a directory.
      const cat = linkCatalogue as ReturnType<typeof analyzeLinkList> | null;
      if (cat?.isLinkList) {
        const name = (slugify(book) || 'links').slice(0, 64);
        saveLinkDirectory(cfg.vault, {
          name,
          source: opts.sourceUrl ?? filePath,
          file: basename(filePath),
          savedAt: new Date().toISOString(),
          sections: cat.sections,
          total: cat.total,
          omitted: cat.omitted,
        });
        const dirKey = `__link_directory__/${name}`;
        await updateQueue(cfg.vault, (entries) => {
          const kept = entries.filter((e) => e.chapter !== placeholderKey
            && e.chapter !== dirKey && !queuedChapters.includes(e.chapter));
          kept.push({
            book, chapter: dirKey,
            title: `link directory: ${cat.total} links catalogued — browse them below`,
            status: 'done',
            ...(opts.sourceUrl ? { sourceUrl: opts.sourceUrl } : {}),
          });
          return kept;
        });
        opts.onComplete?.();
        return; // deliberately NO compile drain: this ingest queued no pages
      }

      if (bankProblems && bankProblems.length > 0) {
        const banked = saveProblems(cfg.vault, bookSlug, bankProblems);
        const bankKey = `__course_bank__/${bookSlug}`;
        await updateQueue(cfg.vault, (entries) => {
          // Any chapters queued before extraction recognized the exam come back out, along with
          // the placeholder and any earlier bank row for the same source (re-ingest replaces).
          const kept = entries.filter((e) => e.chapter !== placeholderKey
            && e.chapter !== bankKey && !queuedChapters.includes(e.chapter));
          kept.push({
            book: bookTitle, chapter: bankKey,
            title: `${banked.length} problems banked`, status: 'done',
          });
          return kept;
        });
        opts.onComplete?.();
        return; // deliberately NO compile drain: this ingest queued no pages
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
      // The conversion is done (success or error); drop its scratch dir rather than leak a
      // /tmp/lwh-convert-* per ingest. (ingestBook cleans its own outDir inline.)
      if (outDir) rmSync(outDir, { recursive: true, force: true });
      // …and the route's input temp dir, now that the converter has finished reading it. Opt-in, so
      // a learner's own local file (no cleanupInputDir passed) is never touched.
      if (opts.cleanupInputDir) rmSync(opts.cleanupInputDir, { recursive: true, force: true });
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
function guardTools(tools: LoopTool[], student: string, knownSlugs: string[]): LoopTool[] {
  return tools.map((t) => ({
    ...t,
    execute: t.execute
      ? async (args: unknown) => t.execute!(sanitizeToolArgs(args, t.name, student, knownSlugs))
      : undefined,
  }));
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
  // Split before each H2 that is a real section heading — locate them in the fence-masked copy so a
  // `## ...` inside a code block doesn't cut a chunk mid-code, then slice the real markdown at those
  // offsets (indices align). Each section keeps its H2 heading with its body.
  const starts = [...maskFences(markdown).matchAll(/^##\s/gm)].map((m) => m.index!);
  const cuts = starts[0] === 0 ? starts : [0, ...starts];
  const sections = cuts.map((c, i) => markdown.slice(c, cuts[i + 1] ?? markdown.length));
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

export function buildCompilePrompt(
  bookTitle: string, chapterN: number, chapterTitle: string, chapterMarkdown: string, existingSlugs: string[],
  partLabel = '',
): string {
  return [
    compileInstructions(),
    `Book: "${bookTitle}"`,
    `Chapter ${chapterN}: "${chapterTitle}"${partLabel}`,
    // Same scale cap as the tutor's slug grounding (session.ts's SLUG_LIST_CAP): a small vault
    // inlines every slug — genuinely useful link candidates — but past the cap the list is
    // thousands of tokens per compile PART that the model cannot meaningfully scan anyway, and
    // write_page's own proposeLinks already surfaces verified candidates by content similarity.
    existingSlugs.length <= SLUG_LIST_CAP
      ? `Existing vault slugs (the ONLY valid slugs for prereqs/deepens/links besides ones you `
        + `write in this batch): ${existingSlugs.join(', ') || '(none yet)'}`
      : `The vault has ${existingSlugs.length} pages — too many to list. Do not guess slugs: for `
        + 'prereqs/deepens/links, reference only pages you write in this batch or the verified '
        + 'candidates write_page proposes back to you.',
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
export async function compileOne(
  lw: Engram, cfg: HarnessConfig, model: ChatModel, entry: QueueEntry,
  chunkChars: number,
): Promise<'compiled' | 'failed'> {
  let status: QueueStatus = 'done';
  let error: string | undefined;
  try {
    const chapterMarkdown = readFileSync(join(cfg.vault, entry.chapter), 'utf8');
    const chapterN = Number(entry.chapter.match(/ch-(\d+)-/)?.[1] ?? 1);
    const chunks = chunkChapter(chapterMarkdown, chunkChars);

    // Citation is a MECHANICAL guarantee, not a prompt hope: every write_page
    // during this compile gets the canonical source merged into its sources array, whether or not
    // the model remembered. Papers cite their fetch URL; book chapters cite book + chapter.
    // Video-sourced compiles get one more mechanical pass: plain [M:SS] stamps the model kept as
    // citation anchors become deep links into the video, so the COMPILED page can jump to the
    // exact second the way the raw transcript already does.
    const citation = entry.sourceUrl
      ? `${entry.book} (${entry.sourceUrl})`
      : `${entry.book} — ${entry.title}`;
    const videoUrl = entry.sourceUrl && isVideoUrl(entry.sourceUrl) ? entry.sourceUrl : null;
    const withCitation = (tools: LoopTool[]): LoopTool[] =>
      tools.map((t) => (t.name !== 'write_page' || !t.execute ? t : {
        ...t,
        execute: (args: any) => t.execute!({
          ...args,
          ...(videoUrl && typeof args?.body === 'string' ? { body: linkifyTimestamps(args.body, videoUrl) } : {}),
          sources: [...new Set([...(Array.isArray(args?.sources) ? args.sources : []), citation])],
        }),
      }));

    let wroteAny = false;
    const partErrors: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      // Refresh slugs per part: part 2's prereq/link candidates include part 1's new pages.
      const slugs = await lw.listSlugs();
      const partLabel = chunks.length > 1 ? ` (part ${i + 1} of ${chunks.length})` : '';
      const prompt = buildCompilePrompt(entry.book, chapterN, entry.title, chunks[i], slugs, partLabel);

      const tools = withCitation(guardTools(await lw.tools(), cfg.student, slugs));
      try {
        const result = await runLoop({
          model,
          system: 'You are compiling one textbook chapter into Engram vault pages.',
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          tools,
          maxSteps: 16,
        });
        recordUsage(cfg.vault, {
          role: 'compile', model: cfg.models?.compile?.model ?? 'unknown', usage: result.usage,
        });
        // "The loop finished" is not "the work happened" — small models sometimes narrate instead
        // of calling tools. Gate on THIS run's own steps (per-entry AND per-part accurate under
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
  lw: Engram, cfg: HarnessConfig, n = 1,
  opts: { model?: ChatModel; concurrency?: number; chunkChars?: number } = {},
): Promise<{ compiled: number; failed: number }> {
  const model = opts.model ?? chatModelFor('compile', cfg);
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
      const outcome = await compileOne(lw, cfg, model, entry, opts.chunkChars ?? CHAPTER_CHUNK_CHARS);
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
 * running both at once is a guaranteed CUDA OOM (see convert.ts's freeOllamaVram comment). A
 * cloud (Anthropic-routed) model never contends for the local GPU, so it is always cleared to run.
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
export function ensureCompileDrain(lw: Engram, cfg: HarnessConfig, opts: { model?: ChatModel } = {}): void {
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
