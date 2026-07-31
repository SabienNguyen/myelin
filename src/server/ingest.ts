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
import { generateStructured, runLoop, type ChatModel, type LoopTool } from './llm/index.js';
import { budgetChars, isTransportFailure, mapPieces } from './pipeline.js';
import { z } from 'zod';
import type { Engram } from './mcp.js';
import { chatModelFor } from './models.js';
import {
  recordIngest, recordSpineChapter, sourceFor, type SourceRecord,
} from './provenance.js';
import { ensureArtifactPaths } from './artifactPath.js';
import {
  enqueueChapters, readQueue, updateQueue, writeQueue, type QueueEntry, type QueueStatus,
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
      enqueueChapters(entries, [{
        book: title,
        chapter: `raw/uploads/${slug}/paper.md`,
        title,
        status: 'pending',
        ...(opts.sourceUrl ? { sourceUrl: opts.sourceUrl } : {}),
      }]);
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
  await updateQueue(cfg.vault, (entries) => { enqueueChapters(entries, newEntries); });

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
    // Where this material came from and who it is credited to (provenance.ts). Recorded once the
    // book's FINAL identity is known — paper mode only learns its title from the converted H1, and
    // a record filed under the placeholder name is a record nothing can look up. `reported` is what
    // the artifact or its platform said (yt-dlp's channel); `claimed` is what a model said, which
    // reconcileAttribution never lets outrank `reported`.
    provenance?: {
      origin: SourceRecord['origin'];
      reported?: string[];
      claimed?: string[];
    };
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

  // Keyed on the same `book` value this conversion's CHAPTER rows carry — not the placeholder's —
  // because that is what compileOne hands sourceFor() and what the Library groups by. Unlabelled
  // doors (a direct startConversion, a learner's own file) still get a record: "a file, authors
  // unknown" is provenance too, and an absent record is indistinguishable from an unrecorded one.
  const recordProvenance = (bookKey: string) => recordIngest(cfg.vault, {
    book: bookKey,
    title: bookKey,
    origin: opts.provenance?.origin ?? { kind: 'file' },
    reported: opts.provenance?.reported,
    claimed: opts.provenance?.claimed,
  });

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
        recordProvenance(title);
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
        recordProvenance(bookTitle); // book mode's identity is the filename — known from the start
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
            enqueueChapters(entries, newEntries);
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

// ---- weak-model compile fallback ---------------------------------------------------------------
//
// The agentic compile above expects the model to DRIVE write_page — which a 7-9B model reliably
// cannot do (it narrates instead of calling tools; observed live: every chapter erroring with
// "no write_page calls — try a stronger compile model"). Same medicine as rails mode: when the
// loop comes back empty, the HARNESS does the orchestration and the model does one narrow
// structured generation per part (title + distilled body, constrained decoding + one retry); if
// even that fails, the deterministic floor writes the source text itself as a draft page, honestly
// labeled. Material always lands in the vault; only an unreachable endpoint still fails the entry —
// that must stay an error so the queue retries when the endpoint recovers, instead of consuming the
// entry with undistilled content during an outage.
//
// Once the FIRST part proves the model can't drive tools, compileOne stops trying the agentic loop
// on the parts after it and hands them all to pipeline.ts's mapPieces, which runs the ladder above
// (attempt, rejection-retry, floor) on `concurrency` parts at once instead of one slow agentic
// round-trip at a time. distillPart is the "attempt" half, writeVerbatim the "floor" half.

const distilledPageSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

function buildDistillPrompt(book: string, chapterTitle: string, partLabel: string, chunk: string): string {
  return [
    `Distill this chapter part into ONE study page.`,
    `Book: "${book}" — chapter: "${chapterTitle}"${partLabel}.`,
    'Fields:',
    '- title: a clear page title for the main concept of this part.',
    '- body: 150-400 words of plain markdown explaining it, self-contained, faithful to the text. '
    + 'No links, no frontmatter, no code fences around the whole body.',
    'Source text:',
    '"""',
    chunk,
    '"""',
  ].join('\n');
}

/** slugify + collision suffix: write_page UPDATES on an existing slug, and a fallback page must
 * never silently overwrite someone's real page. */
function freshSlug(title: string, taken: Set<string>): string {
  const base = slugify(title) || 'compiled-page';
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

/**
 * One structured-distillation attempt for one part: title + body, constrained decoding (or a
 * forced tool call on adapters without response-format support). `mapPieces` owns the ladder now
 * (one attempt, one rejection-retry, then the floor) — this function makes exactly one call and
 * lets any failure (transport or a schema-rejecting model) propagate, so it must never be given
 * its own internal retry or the engine's retry count would silently double.
 */
async function distillPart(
  model: ChatModel, cfg: HarnessConfig,
  book: string, chapterTitle: string, partLabel: string, chunk: string, rejection: string | undefined,
  existingSlugs: Set<string>,
  writePage: (args: unknown) => Promise<unknown>,
): Promise<void> {
  const prompt = buildDistillPrompt(book, chapterTitle, partLabel, chunk);
  const { object, usage } = await generateStructured({
    model,
    prompt: rejection
      ? `${prompt}\n\nYour previous attempt was rejected: ${rejection}. Return a corrected page.`
      : prompt,
    schema: distilledPageSchema,
    schemaName: 'compiled_page',
  });
  recordUsage(cfg.vault, { role: 'compile', model: cfg.models?.compile?.model ?? 'unknown', usage });
  await writePage({ slug: freshSlug(object.title, existingSlugs), title: object.title, body: object.body, status: 'draft' });
}

/**
 * The verbatim floor for one part: the source text itself becomes the page — honest, useful, and
 * replaceable. A stronger compile model recompiling the chapter writes a real distillation
 * alongside it. `cls`/`reason` (why distillation gave up) are threaded through for the ledger note
 * the caller builds from `mapPieces`'s receipts; the page body itself stays a fixed, calm label.
 */
async function writeVerbatim(
  chapterTitle: string, partLabel: string, chunk: string,
  existingSlugs: Set<string>,
  writePage: (args: unknown) => Promise<unknown>,
): Promise<void> {
  await writePage({
    slug: freshSlug(`${chapterTitle}${partLabel}`, existingSlugs),
    title: `${chapterTitle}${partLabel}`,
    body: '> Compiled verbatim: the compile model could not distill this part, so the source text '
      + 'below is the page. Recompile with a stronger model to replace it.\n\n' + chunk,
    status: 'draft',
  });
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
  // Every slug this chapter writes, in the order write_page was called — the chapter's slice of the
  // source's spine (provenance.ts), filed in the finally so a chapter that failed halfway still
  // contributes the pages it did write. Declared out here for that reason alone.
  const writtenSlugs: string[] = [];
  // Book-mode uploads only: `ch-NN-` at the START of the filename is what carries an authored
  // position. A paper (paper.md) is one unit and has no order to preserve, and a repo's doc files
  // (<file>--ch-NN-…) each restart at 01 — several sequences, no single spine — so both correctly
  // fail this match and record none.
  const chapterOrdinal = Number(basename(entry.chapter).match(/^ch-(\d+)-/)?.[1] ?? 0);
  try {
    const chapterMarkdown = readFileSync(join(cfg.vault, entry.chapter), 'utf8');
    const chapterN = Number(entry.chapter.match(/ch-(\d+)-/)?.[1] ?? 1);
    // The configured compile model's own context window caps a part further than the caller's
    // chunkChars might — whichever is tighter wins, so a small-context local model still gets
    // parts it can actually fit (see pipeline.ts's budgetChars doc comment for the char/token math).
    const budget = Math.min(chunkChars, budgetChars(cfg.models?.compile?.contextTokens));
    const chunks = chunkChapter(chapterMarkdown, budget);

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
    // The byline rides the same wrapper as the citation, for the same reason and with one extra
    // rule: the source record's authors REPLACE whatever the model put in `authors`, they are not
    // merged with it. A union would let a compile model append a byline the artifact never carried
    // — which is the misattribution this whole feature exists to prevent, arriving through the one
    // door we control. With no recorded authors the model's own field passes through untouched:
    // engram stores names verbatim, and inventing an empty byline is not an improvement.
    const recordedAuthors = sourceFor(cfg.vault, entry.book)?.authors ?? [];
    // The spine rides this wrapper too, and for the same reason the citation does: it is the one
    // place BOTH compile routes go through — the agentic loop's write_page and distillPart/
    // writeVerbatim's harness-driven one — so neither can produce a page the chapter's order
    // forgets. Call order is the page order; a slug written twice in one chapter (the model
    // updating its own page) stays at its first position rather than becoming a second stop.
    const withCitation = (tools: LoopTool[]): LoopTool[] =>
      tools.map((t) => (t.name !== 'write_page' || !t.execute ? t : {
        ...t,
        execute: (args: any) => {
          const slug = typeof args?.slug === 'string' ? slugify(args.slug) : '';
          if (slug && !writtenSlugs.includes(slug)) writtenSlugs.push(slug);
          return t.execute!({
            ...args,
            ...(videoUrl && typeof args?.body === 'string' ? { body: linkifyTimestamps(args.body, videoUrl) } : {}),
            ...(recordedAuthors.length > 0 ? { authors: recordedAuthors } : {}),
            sources: [...new Set([...(Array.isArray(args?.sources) ? args.sources : []), citation])],
          });
        },
      }));

    let wroteAny = false;
    const partErrors: string[] = [];
    const partNotes: string[] = [];
    // Stays true until some part proves the model can't drive write_page agentically. From that
    // part on, every remaining part (including the one that just proved it) skips the doomed
    // agentic round-trip: a model that narrated instead of calling tools on part 1 of a 32B-token
    // physics chapter will do the same on parts 2 through 40, one slow agentic turn at a time, for
    // no benefit over going straight to harness-driven distillation.
    let agenticAlive = true;
    let firstFallbackPart = chunks.length; // unreached unless the loop below sets it
    for (let i = 0; i < chunks.length && agenticAlive; i++) {
      // Refresh slugs per part: part 2's prereq/link candidates include part 1's new pages. Only
      // meaningful for the agentic path — distillation below never links, so it snapshots once.
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
        if (wrotePage) {
          wroteAny = true;
        } else {
          agenticAlive = false;
          firstFallbackPart = i;
        }
      } catch (partErr: any) {
        const msg = (partErr instanceof Error ? partErr.message : String(partErr)).slice(0, 120);
        // A transport failure fails the part outright — distillation would hit the same dead
        // endpoint; anything else (a weak model mangling the agentic turn) gets the ladder.
        if (isTransportFailure(partErr)) {
          partErrors.push(`part ${i + 1}: ${msg}`);
        } else {
          agenticAlive = false;
          firstFallbackPart = i;
        }
      }
    }

    if (!agenticAlive) {
      // Harness-driven distillation for parts firstFallbackPart..end, `concurrency` at a time. One
      // tools() fetch and one slug snapshot for the whole batch (not per-part, as the agentic loop
      // needs): distillation never links pages together, so there is nothing later parts need to
      // see that earlier ones just wrote.
      const slugs = await lw.listSlugs();
      const tools = withCitation(guardTools(await lw.tools(), cfg.student, slugs));
      // The citation-wrapped execute, so distilled/verbatim pages get the same mechanical source
      // guarantee (and video-timestamp linkify) every agentic write_page gets.
      const writePage = tools.find((t) => t.name === 'write_page')?.execute;
      if (!writePage) {
        for (let i = firstFallbackPart; i < chunks.length; i++) {
          partErrors.push(`part ${i + 1}: no write_page tool available`);
        }
      } else {
        const existingSlugs = new Set(slugs);
        const rest = chunks.slice(firstFallbackPart);
        // NOTE (deferred, see task-4-context.md): mapPieces doesn't cancel sibling workers on a
        // transport throw. A single transient 503 mid-batch can leave some pieces already written
        // while this entry gets marked 'error' and requeued — the retry then redistills those same
        // pieces under fresh freshSlug '-2' suffixes. Out of scope here; noted for the eventual fix.
        const { receipts } = await mapPieces({
          pieces: rest,
          budget,
          concurrency: cfg.models?.compile?.concurrency ?? 4,
          attempt: (piece, rejection) => {
            // rest's chunks come from distinct sections of the chapter, so matching on content to
            // recover this piece's position (for the "(part N of M)" label) is safe in practice;
            // were two chunks ever byte-identical, the label on one would misname its part number
            // — cosmetic only, since `piece` (not the recovered index) is what actually gets
            // distilled and written.
            const idx = firstFallbackPart + rest.indexOf(piece);
            const partLabel = chunks.length > 1 ? ` (part ${idx + 1} of ${chunks.length})` : '';
            return distillPart(model, cfg, entry.book, entry.title, partLabel, piece, rejection, existingSlugs, writePage);
          },
          floor: (piece, _cls, _reason) => {
            const idx = firstFallbackPart + rest.indexOf(piece);
            const partLabel = chunks.length > 1 ? ` (part ${idx + 1} of ${chunks.length})` : '';
            return writeVerbatim(entry.title, partLabel, piece, existingSlugs, writePage);
          },
        });
        receipts.forEach((r, k) => {
          const n = firstFallbackPart + k + 1;
          wroteAny = true;
          partNotes.push(r.outcome === 'ok' ? `part ${n}: distilled` : `part ${n}: verbatim (${r.class}: ${r.reason})`);
        });
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
    if (chapterOrdinal > 0 && writtenSlugs.length > 0) {
      recordSpineChapter(cfg.vault, entry.book, {
        chapter: entry.chapter, chapterOrdinal, title: entry.title, pages: writtenSlugs,
      });
    }
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
      const pendingCount = () => readQueue(cfg.vault).filter((e) => e.status === 'pending').length;
      while (pendingCount() > 0) {
        if (!canCompileNow(compileModelId, activeConversions)) {
          await new Promise((r) => { setTimeout(r, DRAIN_GPU_CONTENTION_BACKOFF_MS); });
          continue;
        }
        // No-progress breaker: a compileNext pass that leaves the pending count no lower than it
        // started did not drain anything it claimed — an entry the mutators cannot move to a
        // terminal status (the stranded-duplicate bug enqueueChapters now prevents). Bail instead
        // of spinning the loop forever, which recompiled a stuck entry thousands of times and
        // filled a fresh vault with junk pages. A GPU-contention backoff `continue`s above without
        // reaching here, so a legitimately-waiting drain is never tripped by this.
        const before = pendingCount();
        await compileNext(lw, cfg, concurrency, { ...opts, concurrency });
        if (pendingCount() >= before) {
          // A pass that moved nothing means the pending entries can't be marked terminal. The one
          // way that happens is a stranded duplicate: a chapter present twice, so compileOne's
          // find(chapter) status write lands on the OTHER row (enqueueChapters prevents this at
          // enqueue time, but two concurrent conversions of the same source can still interleave
          // one in). Prune any pending/compiling entry whose chapter ALSO has a terminal twin —
          // provably redundant, since the content compiled under the twin.
          const sizeBefore = readQueue(cfg.vault).length;
          const after = await updateQueue(cfg.vault, (entries) => {
            const terminal = new Set(
              entries.filter((e) => e.status === 'done' || e.status === 'error').map((e) => e.chapter),
            );
            return entries.filter((e) =>
              !((e.status === 'pending' || e.status === 'compiling') && terminal.has(e.chapter)));
          });
          if (after.length < sizeBefore) continue; // pruned a stranded duplicate — keep draining
          // Nothing to prune and nothing moved: a genuine stall. Bail rather than recompile
          // forever (the runaway that filled a fresh vault with thousands of pages).
          console.error(
            `[ensureCompileDrain] no progress and no stranded duplicates to prune: ${pendingCount()} `
            + `entries stuck pending — stopping to avoid a runaway. Chapters: `
            + after.filter((e) => e.status === 'pending').map((e) => e.chapter).join(', '),
          );
          break;
        }
      }
      // The drain has settled, so every chapter a source queued has reached a terminal status —
      // which is exactly the condition an artifact-led path waits for (artifactPath.ts). Wrapped
      // because a path is a bonus on top of compiled pages: a create_path that rejects must never
      // turn a successful compile run into a logged failure, same stance as the rest of this loop.
      await ensureArtifactPaths(lw, cfg).catch((e) => {
        console.error('[ensureCompileDrain] artifact paths:', e);
        return [];
      });
    } catch (e) {
      console.error('[ensureCompileDrain]', e);
    } finally {
      drainRunning = false;
    }
  })();
}
