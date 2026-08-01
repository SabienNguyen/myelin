import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { HarnessConfig } from '../config.js';
import type { Engram } from '../mcp.js';
import type { AnkiClient } from './client.js';

interface LedgerEntry {
  slug: string;
  hash: string;
}
// Same file as Task 10's outbound ledger (`vault/.harness/anki-map.json`). This module additionally
// stores a `_cursor` key (the last-processed AnkiConnect reviewTime, ms epoch) alongside the
// noteId -> {slug, hash} entries outbound already writes.
type Ledger = Record<string, LedgerEntry> & { _cursor?: number };

function ledgerPath(vault: string): string {
  return join(vault, '.harness', 'anki-map.json');
}
function readLedger(vault: string): Ledger {
  const p = ledgerPath(vault);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Ledger) : {};
}
function writeLedger(vault: string, ledger: Ledger): void {
  mkdirSync(join(vault, '.harness'), { recursive: true });
  writeFileSync(ledgerPath(vault), JSON.stringify(ledger, null, 2));
}

function noteEntries(ledger: Ledger): [string, LedgerEntry][] {
  return Object.entries(ledger).filter(([k]) => k !== '_cursor') as [string, LedgerEntry][];
}

function lapsePath(vault: string): string {
  return join(vault, '.harness', 'anki-lapses.jsonl');
}
function appendLapse(vault: string, date: string, slug: string): void {
  mkdirSync(join(vault, '.harness'), { recursive: true });
  appendFileSync(lapsePath(vault), `${JSON.stringify({ date, slug })}\n`);
}

export interface SyncInboundResult {
  recorded: number;
}

const localDay = (reviewTimeMs: number): string => new Date(reviewTimeMs).toISOString().slice(0, 10);

/**
 * Pulls reviews of Engram-tagged Anki cards since the stored cursor, aggregates them
 * per-slug-per-day, and records evidence through Engram's `record_evidence` tool.
 *
 * Maintain-never-promote ceiling: a day's reviews for a slug map to 'exposed' (refreshes
 * `last_reinforced`, can never raise mastery level) unless any review that day was ease=1
 * (Again), in which case the day maps to 'struggled' instead, and a line is appended to
 * `anki-lapses.jsonl` for `recentLapses()` to surface at session bootstrap.
 *
 * Anki unreachable, or nothing in the outbound ledger yet -> resolves `{recorded: 0}` cleanly,
 * never throws.
 */
export async function syncInbound(
  lw: Engram, anki: AnkiClient, cfg: HarnessConfig,
): Promise<SyncInboundResult> {
  const result: SyncInboundResult = { recorded: 0 };
  if (!(await anki.isUp())) return result; // Anki closed / connection refused — skip silently

  const ledger = readLedger(cfg.vault);
  const notes = noteEntries(ledger);
  if (notes.length === 0) return result; // nothing pushed to Anki yet — nothing to pull back

  const cursor = ledger._cursor ?? 0;
  const noteToSlug = new Map<number, string>(notes.map(([id, v]) => [Number(id), v.slug]));

  // Deck names mirror outbound's `Engram::<domain>` scheme; iterate the domains of every
  // slug currently synced to Anki so cardReviews can be queried per-deck. A card can outlive its
  // page (delete the page, the Anki card and its ledger entry remain), and read_page THROWS on a
  // missing slug — so guard it: a deleted-page slug is dropped rather than allowed to abort the
  // whole sync (the contract is never-throws) and leave the cursor stuck forever. `liveSlugs` also
  // gates evidence below, so a ghost card's reviews are ignored instead of recorded against a page
  // that no longer exists.
  const slugs = [...new Set(notes.map(([, v]) => v.slug))];
  const domains = new Set<string>();
  const liveSlugs = new Set<string>();
  for (const slug of slugs) {
    const page = await lw.call('read_page', { slug }).then((r: any) => r?.page).catch(() => null);
    if (!page) continue;
    liveSlugs.add(slug);
    domains.add(page.domain || 'general');
  }
  const decks = [...domains].map((d) => `Engram::${d}`);

  const allReviews: number[][] = [];
  for (const deck of decks) {
    const chunk = (await anki.invoke('cardReviews', { deck, startID: cursor })) as number[][];
    allReviews.push(...chunk);
  }
  if (allReviews.length === 0) return result;

  let maxReviewTime = cursor;
  for (const r of allReviews) maxReviewTime = Math.max(maxReviewTime, r[0]);

  // Resolve cardID -> noteId (AnkiConnect's cardsInfo returns a `note` field per card) -> slug (ledger).
  const cardIds = [...new Set(allReviews.map((r) => r[1]))];
  const cardsInfo = (await anki.invoke('cardsInfo', { cards: cardIds })) as { cardId: number; note: number }[];
  const cardToNote = new Map<number, number>(cardsInfo.map((c) => [c.cardId, c.note]));

  const groups = new Map<string, { slug: string; day: string; ease: number[] }>();
  for (const r of allReviews) {
    const [reviewTime, cardId, , ease] = r;
    const noteId = cardToNote.get(cardId);
    if (noteId == null) continue;
    const slug = noteToSlug.get(noteId);
    if (!slug || !liveSlugs.has(slug)) continue; // card outside the ledger, or its page was deleted — ignore
    const day = localDay(reviewTime);
    const key = `${slug}|${day}`;
    const g = groups.get(key) ?? { slug, day, ease: [] };
    g.ease.push(ease);
    groups.set(key, g);
  }

  for (const { slug, day, ease } of groups.values()) {
    const lapsed = ease.some((e) => e === 1);
    if (lapsed) {
      await lw.call('record_evidence', {
        student: cfg.student, slug, kind: 'struggled', note: `anki lapse (${ease.length} cards)`,
      });
      appendLapse(cfg.vault, day, slug);
    } else {
      await lw.call('record_evidence', {
        student: cfg.student, slug, kind: 'exposed', note: `anki: ${ease.length} cards recalled`,
      });
    }
    result.recorded++;
  }

  // Advance the cursor only after every group's evidence has been recorded — a crash mid-loop
  // leaves the cursor untouched so the next run re-pulls (record_evidence is itself idempotent
  // enough here: a repeat is just another maintain-never-promote 'exposed'/'struggled' entry).
  ledger._cursor = maxReviewTime;
  writeLedger(cfg.vault, ledger);

  return result;
}

/** Lapse counts per slug over the trailing `days` (default 7) — feeds session bootstrap. */
export function recentLapses(vault: string, days = 7): { slug: string; count: number }[] {
  const p = lapsePath(vault);
  if (!existsSync(p)) return [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const counts = new Map<string, number>();
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const { date, slug } = JSON.parse(line) as { date: string; slug: string };
    if (date >= cutoffStr) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  // Worst-forgotten first. These arrive in file order otherwise, which is the order Anki happened
  // to review them in — so a page lapsed twice could lead a page lapsed four times, and the tutor,
  // reading the list top-down, picks up the milder problem. The count is the whole signal here;
  // ordering by it costs nothing and makes the line read as a priority rather than a set.
  return [...counts]
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
}

/** Days since the last review Anki-side activity was pulled (via the sync cursor). Never synced -> Infinity. */
export function backlogDays(vault: string, now: () => Date = () => new Date()): number {
  const ledger = readLedger(vault);
  if (!ledger._cursor) return Infinity;
  return Math.floor((now().getTime() - ledger._cursor) / 86_400_000);
}
