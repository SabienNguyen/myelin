// Where the vault's material came from and WHO it is by — vault/.harness/sources.json, one record
// per ingested source. A sidecar, not part of the compile-queue ledger: the queue is about work
// still owed, this is about the artifact's identity, which outlives every queue row it produced.
//
// THE INCIDENT (3blue1brown, told on a podcast): he asked a model for a visual explanation of
// semiconductors and got back a real, genuinely good video — attributed to his own channel, which
// had never made it. The video was fine. The byline was invented. When you choose what to learn
// from by WHO made it, a wrong byline is worse than a wrong summary: it spends a reputation that
// was earned somewhere else, and the learner has no way to notice.
//
// So this module applies the app's spine — a model's opinion can never mint the evidence a machine
// check earns — to bylines. An attribution that came from the ARTIFACT ITSELF or its platform/index
// is `verified`. An attribution a MODEL asserted is `claimed`. When both exist and disagree, the
// platform wins, the model's claim is recorded as wrong, and the learner is TOLD (the Library
// renders the warning; recordSource also drops it in the vault's guardrail log next to the other
// integrity findings). Nothing here silently corrects a model — the correction is the product.
//
// The record also carries the source's SPINE — its own chapter order and which pages each chapter
// produced. It belongs here for the same reason the byline does: it is a fact about the artifact,
// not about work still owed, and it has to outlive the queue rows that produced it (the ledger's
// rows are pruned and rewritten; the order Strogatz put his chapters in is not). What reads it is
// artifactPath.ts, which turns that order into a learning path so the model prunes WITHIN the
// author's sequence instead of inventing a competing one.
//
// Storage stance is queueStore.ts's and usageLedger.ts's, for their reasons: a corrupt or
// unreadable file READS AS EMPTY rather than throwing (readSources runs on a chat turn's compile
// and on every Library poll — a raw JSON.parse throw would 500 both), a write failure is logged
// and swallowed (an ingest must not fail because its sidecar could not be written), and a vault
// path of '' is a silent no-op (some test fixtures carry no vault).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logGuardrail } from './sessionStore.js';

export type Attribution = 'verified' | 'claimed' | 'unknown';

export interface SourceRecord {
  /** Book slug — the same key ingest.ts uses for `raw/uploads/<slug>/…` and QueueEntry.book. */
  book: string;
  title: string;
  /** The humans credited. Verbatim names, never slugified. */
  authors: string[];
  attribution: Attribution;
  origin: { kind: 'video' | 'url' | 'file' | 'repo'; url?: string; platform?: string };
  addedAt: string; // ISO
  /** Set ONLY when a model's claimed attribution disagreed with the artifact's own. Human-readable,
   *  names both sides. */
  attributionWarning?: string;
  /** The source's OWN ordering: which pages came from which chapter, in the order the artifact
   *  presents them. This is the thing an artifact-led path exists to preserve. */
  spine?: { chapter: string; chapterOrdinal: number; title: string; pages: string[] }[];
}

/** One chapter's slice of a source's spine — the element type of SourceRecord.spine, named so
 * compileOne and artifactPath.ts can pass one around without restating the shape. */
export type SpineChapter = NonNullable<SourceRecord['spine']>[number];

const sourcesPath = (vault: string) => join(vault, '.harness', 'sources.json');

/** Every recorded source, newest write last. Safe to call from anywhere at any time — the Library
 * polls it, compileOne reads it per chapter — which is exactly why a torn or hand-edited file
 * degrades to "no provenance known" instead of throwing: an unreadable sidecar must cost bylines,
 * never a compile or a page load. */
export function readSources(vault: string): SourceRecord[] {
  if (!vault) return [];
  const p = sourcesPath(vault);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? (parsed as SourceRecord[]) : [];
  } catch {
    return [];
  }
}

/**
 * Upsert one source by `book`. Re-ingesting a source REPLACES its record rather than stacking a
 * second one — same identity rule, for the same reason, as enqueueChapters' upsert by `chapter`
 * (queueStore.ts): `book` is what compileOne and the Library both look a source up by, so a
 * duplicate row means the lookup resolves to the first match forever and the re-ingest's corrected
 * attribution is never the one anybody sees.
 *
 * A record carrying an attributionWarning also lands in the vault's guardrail log HERE, at the one
 * choke point every ingest door goes through, so no door can add a source and forget to report the
 * mismatch it just caught.
 */
export function recordSource(vault: string, rec: SourceRecord): void {
  if (!vault) return;
  try {
    const kept = readSources(vault).filter((r) => r.book !== rec.book);
    kept.push(rec);
    mkdirSync(join(vault, '.harness'), { recursive: true });
    writeFileSync(sourcesPath(vault), JSON.stringify(kept, null, 2));
    if (rec.attributionWarning) {
      logGuardrail(vault, `attribution mismatch for "${rec.book}": ${rec.attributionWarning}`);
    }
  } catch (e) {
    console.error('[provenance] record failed:', e instanceof Error ? e.message : e);
  }
}

export function sourceFor(vault: string, book: string): SourceRecord | undefined {
  return readSources(vault).find((r) => r.book === book);
}

/**
 * Upsert ONE chapter's slice of a source's spine, keyed by `chapter` — the same identity rule, for
 * the same reason, as enqueueChapters (queueStore.ts): recompiling a chapter must REPLACE its
 * pages, never append a second slice, or the artifact's order grows a duplicate stop every time a
 * chapter is compiled again. The spine is kept sorted by `chapterOrdinal` on every write, so a
 * chapter compiled out of order (the drain runs four at a time) still lands where the book puts it.
 *
 * Synchronous from read to write, and that is what makes it safe under the drain's four concurrent
 * compiles: Node never preempts synchronous code, so two workers finishing chapters at the same
 * moment cannot interleave a read-modify-write here and lose each other's slice (queueStore.ts's
 * module doc has the incident where an awaited one did exactly that).
 *
 * A source nobody filed provenance for still gets a spine: ingestBook and the older doors record no
 * SourceRecord, and an artifact must not lose its ordering because the door it came through did not
 * know its byline. The synthesized record says exactly what is known — a file, authors unknown.
 */
export function recordSpineChapter(vault: string, book: string, entry: SpineChapter): void {
  if (!vault) return;
  try {
    const all = readSources(vault);
    const existing = all.find((r) => r.book === book);
    const rec: SourceRecord = existing ?? {
      book,
      title: book,
      authors: [],
      attribution: 'unknown',
      origin: { kind: 'file' },
      addedAt: new Date().toISOString(),
    };
    rec.spine = [...(rec.spine ?? []).filter((s) => s.chapter !== entry.chapter), entry]
      .sort((a, b) => a.chapterOrdinal - b.chapterOrdinal);
    const kept = all.filter((r) => r.book !== book);
    kept.push(rec);
    mkdirSync(join(vault, '.harness'), { recursive: true });
    writeFileSync(sourcesPath(vault), JSON.stringify(kept, null, 2));
  } catch (e) {
    console.error('[provenance] spine record failed:', e instanceof Error ? e.message : e);
  }
}

// ── the guardrail ───────────────────────────────────────────────────────────────────────────

/** Case- and whitespace-insensitive, because "3Blue1Brown" and "3blue1brown " are the same byline
 *  and a diacritic-free false alarm would train the learner to ignore the warning. */
const norm = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');
const clean = (names: string[] | undefined) => (names ?? []).map((n) => n.trim()).filter(Boolean);

/**
 * Decide a source's byline and how much it is worth, given what a model SAID (`claimed`) and what
 * the artifact or its platform REPORTED (`reported`). Pure — the whole guardrail is testable
 * without touching a vault.
 *
 * The platform always wins when it spoke: `reported` is what the artifact's own page/index says
 * about itself, `claimed` is a model's recollection, and the incident this module exists for is
 * precisely a confident recollection overwriting a true byline.
 *
 * Agreement is set INTERSECTION, not equality: a model naming one of three co-authors is right,
 * just incomplete, and calling that a misattribution would fire the warning on the common case and
 * make it worthless. Disagreement means the model named nobody the source credits.
 *
 * A claim with nothing to check it against is `claimed`, not a warning — it is not wrong, it is
 * merely unverified, and the UI must present it that way.
 */
export function reconcileAttribution(
  claimed: string[] | undefined,
  reported: string[] | undefined,
): { authors: string[]; attribution: Attribution; attributionWarning?: string } {
  const said = clean(claimed);
  const own = clean(reported);

  if (own.length === 0) {
    return said.length > 0
      ? { authors: said, attribution: 'claimed' }
      : { authors: [], attribution: 'unknown' };
  }

  const credited = new Set(own.map(norm));
  if (said.length === 0 || said.some((n) => credited.has(norm(n)))) {
    return { authors: own, attribution: 'verified' };
  }
  return {
    authors: own,
    attribution: 'verified',
    attributionWarning:
      `attributed to ${said.join(', ')}, but the source itself credits ${own.join(', ')}`,
  };
}

/**
 * The whole ingest-side sequence — reconcile, stamp, upsert, log a mismatch — in one call, so every
 * door (upload, URL, video, repo) records provenance the same way and none of them can reconcile
 * by hand and get the precedence backwards.
 */
export function recordIngest(vault: string, args: {
  book: string;
  title: string;
  origin: SourceRecord['origin'];
  /** What a MODEL said made this. Never trusted over `reported`. */
  claimed?: string[];
  /** What the artifact/platform reported for this exact artifact. */
  reported?: string[];
}): void {
  recordSource(vault, {
    book: args.book,
    title: args.title,
    origin: args.origin,
    addedAt: new Date().toISOString(),
    ...reconcileAttribution(args.claimed, args.reported),
  });
}
