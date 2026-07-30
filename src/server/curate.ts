// "Who should I read?" — the ranked list of humans, assembled without a model.
//
// 3blue1brown's framing, which frontierResearch.ts already states and this module makes into a
// surface: a model's best role in learning is LIBRARIAN, not author. Route the learner to the
// load-bearing human artifacts and the people behind them, then get out of the way. The most
// useful part of a Wikipedia page is the references at the bottom.
//
// THE CONSTRAINT THAT SHAPES EVERYTHING HERE: no model touches the ranking or the reasons. Every
// string in `why` is a fact an index reported about that exact artifact — a citation count, a view
// count, a runtime, a count of the learner's own recorded evidence — and every one of them can be
// checked by opening the link or the vault. "A great introduction" is not checkable, so it is not
// shipped. The consequence worth stating: this module works identically under a weak local model,
// because it is arithmetic over index results, not judgement.
//
// Best-effort across sources, mirroring findRecentPapers: one index down must not blank the other,
// and both down returns an EMPTY list plus both errors — never a fabricated recommendation. An
// empty list from a reachable index means "nothing found", which is a different thing from "we
// could not look", and callers get to tell them apart.

import type { FrontierPaper } from './frontierResearch.js';
import type { VideoHit } from './videoSearch.js';

export type RecommendationKind = 'paper' | 'video';

export interface Recommendation {
  kind: RecommendationKind;
  title: string;
  /** The humans. Paper: the index's author list. Video: the channel. Verbatim, never slugified. */
  by: string[];
  url: string;
  /** MECHANICAL reasons only, each independently checkable, most-decisive first — so they read in
   *  the order the ranking below applied them, e.g.
   *  ['you have proven 6 evidence entries across 2 pages by Ada Lovelace', '4,182 citations']. */
  why: string[];
  /** True when `by` intersects an author the learner already has proven evidence from. */
  knownAuthor: boolean;
}

export interface ReadingList {
  topic: string;
  recommendations: Recommendation[];
  /** Indexes that failed, named — an empty list with a reachable index means "nothing found",
   *  which is different from "we could not look", and the UI must be able to say which. */
  sourceErrors: string[];
}

/** One row of engram's `author_affinity`, narrowed to the fields this ranking reads. Derived from
 *  recorded evidence, never from a stated preference — see engram's authorAffinity(). */
export interface AuthorAffinityRow {
  author: string;
  /** Positive evidence entries across pages compiled from this author's material. */
  provenEvidence: number;
  /** Pages in the vault that came from their material. */
  pages: number;
}

export interface CurateDeps {
  findCanonicalPapers: (topic: string) => Promise<{ papers: FrontierPaper[]; sourceErrors: string[] }>;
  searchVideos: (query: string, limit?: number) => Promise<VideoHit[]>;
  /** Engram's author_affinity for this learner. Its failure costs the affinity bonus and nothing
   *  else — see buildReadingList. */
  authorAffinity: () => Promise<AuthorAffinityRow[]>;
}

const MAX_TOTAL = 8;
const PER_SOURCE = 8;

/** Thousands separators, because "4182 citations" reads as noise and "4,182 citations" reads as a
 *  number the learner can compare against the next row. */
const fmt = (n: number) => n.toLocaleString('en-US');

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

/** Same normalization provenance.ts uses on bylines: "3Blue1Brown" and "3blue1brown " are one
 *  person, and a case-sensitive miss here would silently drop the affinity bonus. */
const norm = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** A candidate plus the two numbers the ranking sorts on, kept separate from the wire shape so the
 *  sort never has to re-parse a `why` string it just wrote. */
interface Ranked {
  rec: Recommendation;
  /** Citations for a paper, views for a video. Undefined when the index reported none — those rank
   *  last within their kind rather than being assigned a number nobody measured. */
  count?: number;
  /** Proven evidence entries from the matched author, for ordering among known-author rows. */
  affinity: number;
}

/**
 * THE RANKING, in full, and it is arithmetic:
 *
 *   1. An author the learner has PROVEN evidence from sorts above one they have not. This is
 *      Sanderson's "you liked that book, read more by that author", except it is earned — the
 *      evidence is in the vault, not in something the learner said.
 *   2. Within that tier, more proven evidence from the author first.
 *   3. Papers order among themselves by citation count, videos among themselves by view count.
 *      Those two numbers are NOT comparable to each other, so nothing here ever compares them.
 *   4. Missing counts rank last within their kind, and say so in `why` instead of getting a
 *      number nobody reported.
 *   5. The two kinds are then interleaved, papers first: a learner asking "who should I read"
 *      wants the paper AND the explainer, and an all-of-one-kind list answers half the question.
 *      Papers lead because the artifact is the thing being recommended and the video is the way in.
 *   6. Cap at 8 total.
 */
function rank(all: Ranked[]): Recommendation[] {
  // -1 for a missing count, not 0: a video with a reported 0 views is a different claim from one
  // the index reported nothing about, and it must still outrank the unreported one.
  const order = (xs: Ranked[]) => [...xs].sort((a, b) =>
    b.affinity - a.affinity
    || (b.count ?? -1) - (a.count ?? -1));

  const out: Recommendation[] = [];
  for (const known of [true, false]) {
    const tier = all.filter((r) => r.rec.knownAuthor === known);
    const papers = order(tier.filter((r) => r.rec.kind === 'paper'));
    const videos = order(tier.filter((r) => r.rec.kind === 'video'));
    for (let i = 0; i < Math.max(papers.length, videos.length); i++) {
      if (papers[i]) out.push(papers[i].rec);
      if (videos[i]) out.push(videos[i].rec);
    }
  }
  return out.slice(0, MAX_TOTAL);
}

/** Reports both numbers engram counted, so the learner can check either against their own evidence
 *  log. Never characterises the author — the count IS the reason. */
function affinityWhy(row: AuthorAffinityRow): string {
  const entries = row.provenEvidence === 1 ? 'entry' : 'entries';
  return `you have proven ${fmt(row.provenEvidence)} evidence ${entries} across `
    + `${fmt(row.pages)} ${plural(row.pages, 'page')} by ${row.author.trim()}`;
}

export async function buildReadingList(topic: string, deps: CurateDeps): Promise<ReadingList> {
  const [paperResult, videoResult, affinityResult] = await Promise.allSettled([
    deps.findCanonicalPapers(topic),
    deps.searchVideos(topic, PER_SOURCE),
    deps.authorAffinity(),
  ]);

  const sourceErrors: string[] = [];
  // Every entry is "<index>: <what went wrong>" so the UI can say WHICH index it could not reach
  // without parsing prose. findCanonicalPapers wraps its own failure as "no index reachable —
  // Crossref: …"; that wrapper is dropped rather than stacked, but the underlying message is
  // passed through untouched — trimming words out of an error is how a cause gets lost.
  if (paperResult.status === 'rejected') {
    const msg = String((paperResult.reason as Error)?.message ?? paperResult.reason)
      .replace(/^no index reachable — Crossref: /, '');
    sourceErrors.push(`Crossref: ${msg}`);
  }
  if (videoResult.status === 'rejected') {
    sourceErrors.push(`YouTube: ${(videoResult.reason as Error)?.message ?? videoResult.reason}`);
  }
  if (paperResult.status === 'fulfilled') sourceErrors.push(...paperResult.value.sourceErrors);

  // Affinity is a BONUS, not a source: engram being down costs every row its knownAuthor flag and
  // nothing else, so it is not reported as an unreachable index and it never fails the request.
  const affinity = new Map<string, AuthorAffinityRow>();
  if (affinityResult.status === 'fulfilled') {
    for (const row of affinityResult.value ?? []) {
      if (row?.author && row.provenEvidence > 0) affinity.set(norm(row.author), row);
    }
  } else {
    console.error('[curate] author_affinity unavailable:',
      (affinityResult.reason as Error)?.message ?? affinityResult.reason);
  }
  const matchAffinity = (by: string[]) => {
    let best: AuthorAffinityRow | undefined;
    for (const name of by) {
      const row = affinity.get(norm(name));
      if (row && (!best || row.provenEvidence > best.provenEvidence)) best = row;
    }
    return best;
  };

  const candidates: Ranked[] = [];

  if (paperResult.status === 'fulfilled') {
    for (const p of paperResult.value.papers) {
      const known = matchAffinity(p.authors);
      const why: string[] = [];
      if (known) why.push(affinityWhy(known));
      why.push(typeof p.citations === 'number'
        ? `${fmt(p.citations)} ${plural(p.citations, 'citation')}`
        : 'Crossref reports no citation count for this one');
      candidates.push({
        rec: {
          kind: 'paper', title: p.title, by: p.authors, url: p.url, why, knownAuthor: Boolean(known),
        },
        ...(typeof p.citations === 'number' ? { count: p.citations } : {}),
        affinity: known?.provenEvidence ?? 0,
      });
    }
  }

  if (videoResult.status === 'fulfilled') {
    for (const v of videoResult.value) {
      const by = v.channel ? [v.channel] : [];
      const known = matchAffinity(by);
      const why: string[] = [];
      if (known) why.push(affinityWhy(known));
      why.push(typeof v.views === 'number'
        ? `${fmt(v.views)} ${plural(v.views, 'view')}`
        : 'YouTube reports no view count for this one');
      // Runtime is the other fact a learner picks on — a 14-minute explainer and a 3-hour lecture
      // are different offers even at the same view count.
      if (typeof v.durationSeconds === 'number' && v.durationSeconds > 0) {
        why.push(`${fmt(Math.max(1, Math.round(v.durationSeconds / 60)))} min`);
      }
      candidates.push({
        rec: { kind: 'video', title: v.title, by, url: v.url, why, knownAuthor: Boolean(known) },
        ...(typeof v.views === 'number' ? { count: v.views } : {}),
        affinity: known?.provenEvidence ?? 0,
      });
    }
  }

  return { topic, recommendations: rank(candidates), sourceErrors };
}

// ---- what THIS SERVER looked up, so a curated ingest can be verified ---------------------------
//
// The byline problem, from the route's side. `/api/ingest` accepts an `authors` field, and that
// field is a CLAIM by whoever called it — provenance.ts is emphatic that a caller must never be
// able to mint a verified byline, or the whole verified/claimed distinction is theatre. But a
// recommendation's authors did not come from a caller: the SERVER asked Crossref for that exact
// URL and Crossref answered. That is the artifact's own metadata, obtained by us.
//
// So the server remembers what it looked up, keyed by the URL it looked it up for, and the ingest
// route consults THIS map rather than trusting the request body. A URL the server never indexed is
// simply absent, and the claim path applies unchanged. Bounded and in-memory on purpose: it is a
// within-session convenience, not a store — a restart costs a byline its verification, which is
// the honest failure direction.
const INDEXED_BYLINE_CAP = 300;
const indexedBylines = new Map<string, string[]>();

/** Called for every recommendation the server hands out — the index said this, for this URL. */
export function rememberIndexedByline(url: string, authors: string[]): void {
  if (!url || authors.length === 0) return;
  // Re-inserting moves a URL to the newest position, so an actively-offered recommendation is not
  // evicted by an older one's insertion order.
  indexedBylines.delete(url);
  indexedBylines.set(url, authors);
  while (indexedBylines.size > INDEXED_BYLINE_CAP) {
    const oldest = indexedBylines.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    indexedBylines.delete(oldest);
  }
}

/** The byline the server itself obtained for this URL, or undefined if it never looked it up. */
export function indexedBylineFor(url: string): string[] | undefined {
  return indexedBylines.get(url);
}

/** Test seam: forget everything, so one process can exercise indexed and unindexed URLs. */
export function resetIndexedBylines(): void {
  indexedBylines.clear();
}
