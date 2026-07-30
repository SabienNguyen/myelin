// A book's own chapter order, turned into an engram learning path.
//
// THE REVERSAL: `compile_source` extracts atomic concepts and links them into engram's prereq graph,
// and until now a path was an ordered syllabus THE MODEL INVENTED (the tutor prompt's rule 7a). That
// threw away the one part of a textbook nobody can regenerate — the sequence its author spent years
// getting right. Dwarkesh Patel describes learning Strogatz's *Nonlinear Dynamics and Chaos* with
// the lecture on one third of the screen, the textbook on another, and the model on the third: the
// book ORDERS THE CONCEPTS, the model prunes around the branch the book already identified. This
// module is that arrangement, made mechanical. The atomic pages are unchanged; the ordering is added
// on top of them, and the model's job becomes pruning WITHIN it — skip what the learner has proven,
// go deeper where they have not.
//
// THE CONFLICT POLICY, deliberately: where the book's order contradicts our prereq graph — a page
// appearing before a page it lists as a prereq — THE BOOK WINS and nothing is reordered. Grant
// Sanderson's point is the reason: good exposition is sometimes a little wrong on the way and
// corrects itself later, and a good expositor will introduce something before its formal
// prerequisite on purpose, because the intuition has to land before the machinery means anything.
// Our prereq edges are derived per-page by a compile model; the author's ordering is the artifact's
// most valuable and least reproducible part. So the disagreement is COUNTED AND LOGGED, naming both
// pages, rather than silently "fixed" — a visible disagreement is a finding, a silent one is a lie.

import type { HarnessConfig } from './config.js';
import { slugify } from './ingest.js';
import type { Engram } from './mcp.js';
import { readSources, type SourceRecord } from './provenance.js';
import { readQueue, type QueueEntry } from './queueStore.js';
import { logGuardrail } from './sessionStore.js';

/** A textbook that disagrees with the graph in fifty places is one finding, not fifty — the count is
 * the signal, the examples are there to make it checkable. */
const CONFLICTS_LOGGED = 5;

/** Stable and namespaced: recompiling a source must REFRESH its path rather than mint a second one
 * (create_path overwrites by slug), and the prefix keeps an artifact-led path from colliding with a
 * model-authored one, which is named after a subject rather than a book. */
export function artifactPathSlug(book: string): string {
  return `source-${slugify(book) || 'artifact'}`;
}

/** Book order flattened into path stops: chapters by their ordinal, and within a chapter the order
 * compile wrote the pages. A slug written under two chapters keeps its FIRST position — a stop the
 * learner passes twice is not a stop. */
function spinePages(spine: NonNullable<SourceRecord['spine']>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const ch of [...spine].sort((a, b) => a.chapterOrdinal - b.chapterOrdinal)) {
    for (const slug of ch.pages) {
      if (!seen.has(slug)) { seen.add(slug); ordered.push(slug); }
    }
  }
  return ordered;
}

/** Every chapter this source queued is finished (`done` or `error`) — an errored chapter still
 * counts, because it is not coming back on its own and the pages it did write belong in the order.
 * Synthetic placeholder rows (`__converting__/…`, `__course_bank__/…`) are conversion bookkeeping,
 * not chapters: a `convert-error` placeholder left behind by a restart must not withhold the path
 * from the chapters that compiled perfectly well. */
function chaptersSettled(ledger: QueueEntry[], book: string): boolean {
  return ledger
    .filter((e) => e.book === book && !e.chapter.startsWith('__'))
    .every((e) => e.status === 'done' || e.status === 'error');
}

function narrativeFor(rec: SourceRecord, chapters: number): string {
  const by = rec.authors.length > 0 ? ` by ${rec.authors.join(', ')}` : '';
  return `The ${chapters} chapters of "${rec.title}"${by}, in the order the source itself presents `
    + 'them. This ordering is the book\'s, not ours — it was read off the artifact as its pages were '
    + 'compiled, not derived from the prereq graph. Work through it in order and skip what you have '
    + 'already proven, rather than re-sequencing it.';
}

/**
 * Where the book's order and our prereq graph disagree, named page by page. Returns one line per
 * conflict: page X sits at stop 3, and stop 5 is a page X calls its own prerequisite.
 *
 * Reads `list_pages` (one call, whole vault) rather than a read_page per stop. A failure to read the
 * graph costs the audit, never the path — the path is the product; the disagreement report is
 * commentary on it.
 */
async function prereqConflicts(lw: Engram, pages: string[]): Promise<string[]> {
  let meta: { slug: string; prereqs?: string[] }[];
  try {
    ({ pages: meta } = await lw.call('list_pages', {}) as { pages: { slug: string; prereqs?: string[] }[] });
  } catch (e) {
    console.error('[artifactPath] prereq audit skipped:', e instanceof Error ? e.message : e);
    return [];
  }
  const positionOf = new Map(pages.map((slug, i) => [slug, i]));
  const conflicts: string[] = [];
  for (const page of meta) {
    const at = positionOf.get(page.slug);
    if (at === undefined) continue;
    for (const prereq of page.prereqs ?? []) {
      const prereqAt = positionOf.get(prereq);
      if (prereqAt !== undefined && prereqAt > at) {
        conflicts.push(`"${page.slug}" (stop ${at + 1}) is taught before its prereq "${prereq}" (stop ${prereqAt + 1})`);
      }
    }
  }
  return conflicts;
}

/**
 * Create or refresh one artifact-led path per recorded source that has a spine worth walking, and
 * return the path slugs written.
 *
 * A source qualifies when its spine has TWO OR MORE chapters (one chapter is a chapter, not a
 * sequence; a paper records no spine at all) and every chapter it queued has settled — a path built
 * while chapters are still pending would present a half-book as the whole of it.
 *
 * Slugs the vault no longer holds are dropped: `create_path` rejects a path containing an unknown
 * page outright, and one page deleted in Obsidian must cost that stop, not the entire spine.
 *
 * A source whose `create_path` is rejected is logged and skipped, never allowed to take the other
 * sources' paths down with it — this runs at the tail of a background drain whose real job is
 * compiling (ensureCompileDrain), and that job is already finished by the time it is called.
 */
export async function ensureArtifactPaths(lw: Engram, cfg: HarnessConfig): Promise<string[]> {
  const sources = readSources(cfg.vault).filter((r) => (r.spine?.length ?? 0) >= 2);
  if (sources.length === 0) return [];

  const ledger = readQueue(cfg.vault);
  const known = new Set(await lw.listSlugs());
  const created: string[] = [];

  for (const rec of sources) {
    if (!chaptersSettled(ledger, rec.book)) continue;
    const pages = spinePages(rec.spine!).filter((slug) => known.has(slug));
    if (pages.length === 0) continue;

    const slug = artifactPathSlug(rec.book);
    try {
      await lw.call('create_path', {
        slug,
        title: rec.title,
        pages,
        narrative: narrativeFor(rec, rec.spine!.length),
      });
      created.push(slug);
    } catch (e) {
      console.error(`[artifactPath] "${rec.book}":`, e instanceof Error ? e.message : e);
      continue;
    }

    const conflicts = await prereqConflicts(lw, pages);
    if (conflicts.length > 0) {
      // One line per path, not per conflict: this is a standing property of the book, and a learner
      // scanning the guardrail log needs to see "these N stops disagree with the graph, and the book
      // was kept" once, not N times per recompile.
      const shown = conflicts.slice(0, CONFLICTS_LOGGED);
      logGuardrail(
        cfg.vault,
        `artifact path "${slug}" keeps the source's own order over ${conflicts.length} prereq `
        + `disagreement(s) — the author's sequence wins: ${shown.join('; ')}`
        + (conflicts.length > shown.length ? `; and ${conflicts.length - shown.length} more` : ''),
      );
    }
  }

  return created;
}
