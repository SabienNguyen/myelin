import { ToolLoopAgent, isStepCount, type LanguageModel, type ToolSet } from 'ai';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessConfig } from './config.js';
import { defaultConverter, splitChapters, type Converter } from './convert.js';
import type { Loreweaver } from './mcp.js';
import { modelFor } from './models.js';
import { sanitizeToolArgs } from './session.js';

const here = dirname(fileURLToPath(import.meta.url));

export type QueueStatus = 'pending' | 'compiling' | 'done' | 'error';
export interface QueueEntry {
  book: string;
  chapter: string; // vault-relative path, e.g. 'raw/uploads/<book-slug>/ch-01-....md'
  title: string;
  status: QueueStatus;
  error?: string;
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

/**
 * Converts a book file to per-chapter markdown under vault/raw/uploads/<book-slug>/ and appends
 * one 'pending' ledger entry per chapter to vault/.harness/compile-queue.json. These are the only
 * two locations this pipeline ever writes — pages/ and students/ are the Loreweaver MCP server's
 * exclusive territory.
 */
export async function ingestBook(
  cfg: HarnessConfig, filePath: string, opts: { converter?: Converter } = {},
): Promise<{ book: string; chapters: number }> {
  const converter = opts.converter ?? defaultConverter;
  const bookTitle = basename(filePath, extname(filePath));
  const bookSlug = slugify(bookTitle) || 'book';
  const uploadsDir = join(cfg.vault, 'raw', 'uploads', bookSlug);
  mkdirSync(uploadsDir, { recursive: true });

  const outDir = mkdtempSync(join(tmpdir(), 'lwh-convert-'));
  const { markdown } = await converter(filePath, outDir);
  const chapters = splitChapters(markdown);

  const ledger = readQueue(cfg.vault);
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
 * Takes the next `n` 'pending' ledger entries and runs a one-shot compile agent per chapter,
 * passing the chapter markdown inline (never globbing the vault). The ledger is written after
 * every chapter (crash-safe, same pattern as anki-map.json) so a crash mid-batch leaves already
 * -compiled chapters marked 'done' and only the in-flight one re-attempted.
 */
export async function compileNext(
  lw: Loreweaver, cfg: HarnessConfig, n = 1, opts: { model?: LanguageModel } = {},
): Promise<{ compiled: number; failed: number }> {
  const model = opts.model ?? modelFor('compile', cfg);
  const ledger = readQueue(cfg.vault);
  const batch = ledger.filter((e) => e.status === 'pending').slice(0, n);

  let compiled = 0;
  let failed = 0;

  for (const entry of batch) {
    entry.status = 'compiling';
    writeQueue(cfg.vault, ledger);

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

      await agent.generate({
        prompt: buildCompilePrompt(entry.book, chapterN, entry.title, chapterMarkdown, slugs),
      });

      entry.status = 'done';
      compiled++;
    } catch (e: any) {
      entry.status = 'error';
      entry.error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      failed++;
    }
    writeQueue(cfg.vault, ledger);
  }

  return { compiled, failed };
}
