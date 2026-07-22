/**
 * Repairs the "book1" (Murphy, "Probabilistic Machine Learning") ingest: the old splitChapters
 * only caught H1-level chapter headings, so several real chapters that marker rendered at H2 got
 * merged into a neighboring chapter's raw file (see convert.ts's promoteEmbeddedChapters). This
 * script re-splits book1's existing raw/uploads files with the fixed logic, brings the ledger in
 * line (new pending entries for newly-separated chapters, in-place title cleanup for the two
 * LaTeX-mangled titles, book renamed to its real title), and mechanically rewrites already-
 * compiled pages' frontmatter `sources:` citations that pointed at the old merged-file boundaries.
 *
 * DRY RUN BY DEFAULT — prints the full plan and writes nothing. Pass --apply to execute.
 *
 *   npx tsx scripts/repair-book-split.ts            # dry run
 *   npx tsx scripts/repair-book-split.ts --apply     # writes files, ledger, and page frontmatter
 *
 * Concurrency safety: if any book1 ledger entry is currently 'compiling', this script never
 * touches that entry's raw file or ledger row (prints a notice instead) — the live compile has
 * already read that file's content into memory and will write the WHOLE ledger array back when it
 * finishes, so mutating that one row here would just get lost anyway; re-run this script after the
 * compile completes to pick it up. Every other book1 row proceeds normally.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type HarnessConfig } from '../src/server/config.js';
import { cleanHeading, promoteEmbeddedChapters } from '../src/server/convert.js';
import { readQueue, slugify, writeQueue, type QueueEntry } from '../src/server/ingest.js';

const BOOK_SLUG = 'book1';
const NEW_BOOK_NAME = 'Probabilistic Machine Learning';

const HEADER_COMMENT_RE = /^<!--[\s\S]*?-->\n\n/;
const H1_LINE_RE = /^#\s+(.+)$/m;
const FILE_INDEX_RE = /ch-(\d+)-/;

interface BookFile {
  fileIndex: number;
  path: string; // absolute
  relPath: string; // vault-relative, matches QueueEntry.chapter
  filename: string;
  ledgerEntry: QueueEntry; // snapshot, pre-repair
  pieces: { title: string; body: string }[]; // promoteEmbeddedChapters output
}

interface FileOutcome {
  fileIndex: number;
  filename: string;
  oldTitle: string;
  status: QueueEntry['status'];
  titleChanged: boolean; // true whenever cleanHeading (LaTeX stripping) altered this row's own title
  actions: string[]; // human-readable, in order
}

interface PageOutcome {
  relPath: string;
  changes: { from: string; to: string }[];
}

interface RepairPlan {
  files: BookFile[];
  newFiles: Map<string, string>; // absolute path -> full file content
  rewrittenFiles: Map<string, string>; // absolute path -> full file content (existing file, shrunk)
  newLedger: QueueEntry[];
  citationByFileIndex: Map<number, string>;
  notices: string[];
  fileOutcomes: FileOutcome[];
  pageOutcomes: PageOutcome[];
  pagesScanned: number;
  pageRewrites: Map<string, string>; // absolute path -> full file content, for every entry in pageOutcomes
}

/** Loads book1's raw chapter files in ch-NN order and re-splits each one via
 * promoteEmbeddedChapters (NOT splitChapters — a single already-per-chapter file only has one H1,
 * which would send it through splitChapters' own <2-H1s H2-fallback branch and shatter it on every
 * dotted subsection; see that function's own comment). Pure read — no writes. */
function loadBookFiles(vault: string, bookSlug: string): { files: BookFile[]; originalLedger: QueueEntry[] } {
  const uploadsDir = join(vault, 'raw', 'uploads', bookSlug);
  const originalLedger = readQueue(vault);
  const bookRows = originalLedger.filter((e) => e.book === bookSlug);
  const filenames = readdirSync(uploadsDir).filter((f) => f.endsWith('.md')).sort();

  const files: BookFile[] = filenames.map((filename) => {
    const m = filename.match(FILE_INDEX_RE);
    if (!m) throw new Error(`unexpected filename (no ch-NN- prefix): ${filename}`);
    const fileIndex = Number(m[1]);
    const path = join(uploadsDir, filename);
    const relPath = `raw/uploads/${bookSlug}/${filename}`;
    const ledgerEntry = bookRows.find((e) => e.chapter === relPath);
    if (!ledgerEntry) {
      throw new Error(`no ledger entry for ${relPath} — book1 ledger and raw files are out of sync, aborting`);
    }

    const raw = readFileSync(path, 'utf8');
    const body = raw.replace(HEADER_COMMENT_RE, '').trim();
    const title = cleanHeading(body.match(H1_LINE_RE)?.[1] ?? ledgerEntry.title);
    const pieces = promoteEmbeddedChapters({ title, body });

    return { fileIndex, path, relPath, filename, ledgerEntry, pieces };
  });

  return { files, originalLedger };
}

/** For a re-split file's pieces, the citation string every page that cited the OLD merged file
 * should now use: the exact new chapter title when the file turned out to hold exactly one real
 * chapter (unambiguous), or a "chs. X–Y" range when it held several (a page compiled from the old
 * merged blob could have drawn on any of them — no way to tell which mechanically). */
function citationFor(pieces: { title: string }[]): string {
  if (pieces.length === 1) return `${NEW_BOOK_NAME} — ${pieces[0].title}`;
  const numbers = pieces.map((p) => p.title.match(/^(\d{1,2})\b/)?.[1]);
  if (numbers.every((n): n is string => n != null)) {
    return `${NEW_BOOK_NAME} — chs. ${numbers[0]}–${numbers[numbers.length - 1]}`;
  }
  // Defensive fallback (not hit by book1's real data): a promoted piece without a leading number
  // (shouldn't happen — PROMOTABLE_CHAPTER_HEADING only promotes digit- or single-letter-led
  // headings) makes a clean numeric range impossible; cite the head chapter's exact title instead.
  return `${NEW_BOOK_NAME} — ${pieces[0].title}`;
}

const headerFor = (bookName: string, n: number, title: string) => `<!-- source: "${bookName}", chapter ${n}: "${title}" -->\n\n`;

function buildLedgerAndFilePlan(vault: string, bookSlug: string): {
  files: BookFile[]; newFiles: Map<string, string>; rewrittenFiles: Map<string, string>;
  newLedger: QueueEntry[]; citationByFileIndex: Map<number, string>; notices: string[]; fileOutcomes: FileOutcome[];
} {
  const { files, originalLedger } = loadBookFiles(vault, bookSlug);
  const newFiles = new Map<string, string>();
  const rewrittenFiles = new Map<string, string>();
  const citationByFileIndex = new Map<number, string>();
  const notices: string[] = [];
  const fileOutcomes: FileOutcome[] = [];
  const newPendingRows: QueueEntry[] = [];
  const rowReplacement = new Map<string, QueueEntry>(); // keyed by original relPath

  let nextFileIndex = Math.max(...files.map((f) => f.fileIndex)) + 1;

  for (const file of files) {
    const { fileIndex, ledgerEntry, pieces } = file;
    citationByFileIndex.set(fileIndex, citationFor(pieces));

    if (ledgerEntry.status === 'compiling') {
      notices.push(
        `SKIPPED ${file.filename} — ledger status is 'compiling' (title "${ledgerEntry.title}"). Its raw file `
        + `and ledger row (including the 'book' field — it will keep showing "${bookSlug}", not `
        + `"${NEW_BOOK_NAME}", until this is re-run) are left untouched. Re-run this script with --apply after `
        + `the compile finishes${pieces.length > 1 ? ` to split it into ${pieces.length} chapters` : ' (no split needed — it re-splits to a single chapter, so nothing would change anyway)'}.`,
      );
      fileOutcomes.push({
        fileIndex, filename: file.filename, oldTitle: ledgerEntry.title, status: ledgerEntry.status,
        titleChanged: false, actions: ['skipped (compiling)'],
      });
      continue;
    }

    const head = pieces[0];
    const titleChanged = head.title !== ledgerEntry.title;
    rowReplacement.set(file.relPath, { ...ledgerEntry, title: head.title, book: NEW_BOOK_NAME });

    if (pieces.length === 1) {
      const actions = titleChanged
        ? [`title cleaned in place: "${ledgerEntry.title}" -> "${head.title}"`]
        : ['unchanged'];
      fileOutcomes.push({
        fileIndex, filename: file.filename, oldTitle: ledgerEntry.title, status: ledgerEntry.status, titleChanged, actions,
      });
      continue;
    }

    rewrittenFiles.set(file.path, `${headerFor(NEW_BOOK_NAME, fileIndex, head.title)}${head.body}\n`);
    const actions = [
      `kept (body shrunk to just this chapter${titleChanged ? ', title cleaned in place' : ''}): `
      + `"${ledgerEntry.title}" -> "${head.title}"`,
    ];
    for (const piece of pieces.slice(1)) {
      const n = nextFileIndex++;
      const slug = slugify(piece.title) || `chapter-${n}`;
      const filename = `ch-${String(n).padStart(2, '0')}-${slug}.md`;
      const path = join(vault, 'raw', 'uploads', bookSlug, filename);
      newFiles.set(path, `${headerFor(NEW_BOOK_NAME, n, piece.title)}${piece.body}\n`);
      newPendingRows.push({
        book: NEW_BOOK_NAME,
        chapter: `raw/uploads/${bookSlug}/${filename}`,
        title: piece.title,
        status: 'pending',
        ...(ledgerEntry.sourceUrl ? { sourceUrl: ledgerEntry.sourceUrl } : {}),
      });
      actions.push(`new pending chapter: ch-${String(n).padStart(2, '0')} "${piece.title}"`);
    }
    fileOutcomes.push({
      fileIndex, filename: file.filename, oldTitle: ledgerEntry.title, status: ledgerEntry.status, titleChanged, actions,
    });
  }

  const newLedger = originalLedger.map((e) => rowReplacement.get(e.chapter) ?? e);
  newLedger.push(...newPendingRows);

  return { files, newFiles, rewrittenFiles, newLedger, citationByFileIndex, notices, fileOutcomes };
}

/** Minimal YAML scalar decode for a single `  - <item>` list entry — handles the two quoting
 * styles actually present in this vault's pages (single-quoted, with '' as the escaped quote; and
 * bare/unquoted). Not a general YAML parser — deliberately narrow, matching only what write_page's
 * own serializer actually emits, so it never has to guess about forms that aren't on disk. */
function decodeYamlListItem(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, '$1');
  return t;
}

const CHAPTER_N_RE = /^chapter\s+(\d{1,2})$/i;
const BOOK_DASH_RE = /^book1\s+—\s+(.+)$/;

/**
 * Rewrites a compiled page's `sources:` block-style list in place: any item that's exactly
 * `chapter <N>` (case-insensitive, N being the OLD merged-file index — NOT a real book chapter
 * number, see convert.ts/ingest.ts comments) or `book1 — <old title>` becomes the corrected
 * citation. Every other item (bare `book1`, dotted subsection refs like `chapter 4.7.3`, the
 * model's own free-text citations) is left exactly as-is — mechanical, narrowly scoped, no attempt
 * to fix anything this script can't derive with certainty. Touches only the `sources:` bullet
 * lines; everything else in the file is byte-identical. Returns the original string unchanged (by
 * reference-equal content) when nothing qualifies.
 *
 * Only handles block-style `sources:\n  - item\n  - item` (what every page in this vault actually
 * uses) — a flow-style `sources: [a, b]` line is left alone, since none exist here.
 */
function rewritePageSources(
  content: string, citationByFileIndex: Map<number, string>, titleToFileIndex: Map<string, number>,
): { content: string; changes: { from: string; to: string }[] } {
  const lines = content.split('\n');
  if (lines[0] !== '---') return { content, changes: [] };
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { fmEnd = i; break; }
  if (fmEnd === -1) return { content, changes: [] };

  let sourcesIdx = -1;
  for (let i = 1; i < fmEnd; i++) if (/^sources:\s*$/.test(lines[i])) { sourcesIdx = i; break; }
  if (sourcesIdx === -1) return { content, changes: [] };

  const changes: { from: string; to: string }[] = [];
  for (let i = sourcesIdx + 1; i < fmEnd; i++) {
    const bullet = lines[i].match(/^ {2}- (.*)$/);
    if (!bullet) break;
    const item = decodeYamlListItem(bullet[1]);

    let replacement: string | undefined;
    const chapterMatch = item.match(CHAPTER_N_RE);
    if (chapterMatch) {
      replacement = citationByFileIndex.get(Number(chapterMatch[1]));
    } else {
      const dashMatch = item.match(BOOK_DASH_RE);
      if (dashMatch) {
        const fileIndex = titleToFileIndex.get(dashMatch[1]);
        if (fileIndex != null) replacement = citationByFileIndex.get(fileIndex);
      }
    }

    if (replacement != null && replacement !== item) {
      changes.push({ from: item, to: replacement });
      lines[i] = `  - ${replacement}`;
    }
  }

  return changes.length ? { content: lines.join('\n'), changes } : { content, changes: [] };
}

function walkMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkMarkdownFiles(p));
    else if (st.isFile() && name.endsWith('.md')) out.push(p);
  }
  return out;
}

function buildPageRepairPlan(
  vault: string, citationByFileIndex: Map<number, string>, titleToFileIndex: Map<string, number>,
): { pageOutcomes: PageOutcome[]; pagesScanned: number; rewritten: Map<string, string> } {
  const pagesDir = join(vault, 'pages');
  const pageFiles = walkMarkdownFiles(pagesDir);
  const pageOutcomes: PageOutcome[] = [];
  const rewritten = new Map<string, string>();

  for (const path of pageFiles) {
    const content = readFileSync(path, 'utf8');
    const { content: next, changes } = rewritePageSources(content, citationByFileIndex, titleToFileIndex);
    if (changes.length) {
      const relPath = path.slice(pagesDir.length + 1);
      pageOutcomes.push({ relPath, changes });
      rewritten.set(path, next);
    }
  }

  return { pageOutcomes, pagesScanned: pageFiles.length, rewritten };
}

export function buildRepairPlan(vault: string): RepairPlan {
  const {
    files, newFiles, rewrittenFiles, newLedger, citationByFileIndex, notices, fileOutcomes,
  } = buildLedgerAndFilePlan(vault, BOOK_SLUG);

  const titleToFileIndex = new Map(files.map((f) => [f.ledgerEntry.title, f.fileIndex]));
  const { pageOutcomes, pagesScanned, rewritten } = buildPageRepairPlan(vault, citationByFileIndex, titleToFileIndex);

  return {
    files, newFiles, rewrittenFiles, newLedger, citationByFileIndex, notices, fileOutcomes,
    pageOutcomes, pagesScanned, pageRewrites: rewritten,
  };
}

function printPlan(plan: RepairPlan, apply: boolean): void {
  const line = (s = '') => console.log(s);
  line(`repair-book-split: ${apply ? 'APPLY' : 'DRY RUN'} — book "${BOOK_SLUG}" -> "${NEW_BOOK_NAME}"`);
  line('='.repeat(72));

  line('\nPer-file outcome:');
  for (const f of plan.fileOutcomes) {
    line(`  [${String(f.fileIndex).padStart(2, '0')}] ${f.filename} (status: ${f.status})`);
    line(`       old title: "${f.oldTitle}"`);
    for (const a of f.actions) line(`       - ${a}`);
  }

  const newChapterCount = plan.fileOutcomes.reduce(
    (n, f) => n + f.actions.filter((a) => a.startsWith('new pending chapter:')).length, 0,
  );
  const titleCleanCount = plan.fileOutcomes.filter((f) => f.titleChanged).length;

  if (plan.notices.length) {
    line('\nNotices:');
    for (const n of plan.notices) line(`  ! ${n}`);
  }

  line('\nCitation mapping (old file index -> new citation string):');
  for (const [idx, citation] of [...plan.citationByFileIndex.entries()].sort((a, b) => a[0] - b[0])) {
    line(`  chapter ${idx} -> "${citation}"`);
  }

  line(`\nPage frontmatter repair: ${plan.pagesScanned} page(s) scanned under vault/pages, ${plan.pageOutcomes.length} need rewriting.`);
  for (const p of plan.pageOutcomes) {
    line(`  pages/${p.relPath}`);
    for (const c of p.changes) line(`       "${c.from}" -> "${c.to}"`);
  }

  line('\nSummary:');
  line(`  new pending chapters to create: ${newChapterCount}`);
  line(`  titles cleaned in place: ${titleCleanCount}`);
  line(`  raw files rewritten (shrunk): ${plan.rewrittenFiles.size}`);
  line(`  raw files newly created: ${plan.newFiles.size}`);
  line(`  ledger rows after repair: ${plan.newLedger.length} (was ${plan.newLedger.length - newChapterCount})`);
  line(`  pages to rewrite: ${plan.pageOutcomes.length}`);
  line(`  book renamed: "${BOOK_SLUG}" -> "${NEW_BOOK_NAME}" (all rows except any left 'compiling')`);

  line(apply ? '\nAPPLY complete — all of the above was written.' : '\nDRY RUN — nothing was written. Re-run with --apply to execute.');
}

function applyPlan(vault: string, plan: RepairPlan): void {
  for (const [path, content] of plan.rewrittenFiles) writeFileSync(path, content);
  for (const [path, content] of plan.newFiles) writeFileSync(path, content);
  writeQueue(vault, plan.newLedger);
  for (const [path, content] of plan.pageRewrites) writeFileSync(path, content);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const cfg: HarnessConfig = loadConfig();
  const plan = buildRepairPlan(cfg.vault);
  printPlan(plan, apply);
  if (apply) applyPlan(cfg.vault, plan);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((e) => {
    console.error('[repair-book-split] failed:', e instanceof Error ? e.stack ?? e.message : e);
    process.exitCode = 1;
  });
}
