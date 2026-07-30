import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { HarnessConfig } from '../config.js';
import type { Engram } from '../mcp.js';
import { modelFor } from '../models.js';
import type { AnkiClient } from './client.js';

export type GenerateCards = (
  slug: string,
  page: any,
  misconceptions: string[],
) => Promise<{ front: string; back: string }[]>;

export interface SyncOutboundResult {
  pushed: number;
  updated: number;
  skipped: number;
  /** Pages whose card GENERATION failed (model returned unparseable JSON, network error) — the
   * sync carries on with the other pages instead of aborting the whole run. */
  failed: number;
}

interface LedgerEntry {
  slug: string;
  hash: string;
}
type Ledger = Record<string, LedgerEntry>;

const cardsSchema = z.object({
  cards: z.array(z.object({ front: z.string(), back: z.string() })).max(4),
});

const CARD_PROMPT = 'Create at most 4 atomic flashcards for this page. Front = one precise question; '
  + 'Back = the answer in ≤ 2 sentences. If misconceptions are listed, make the FIRST card target the '
  + 'misconception directly.';

function isKnown(level: string): boolean {
  return level === 'practicing' || level === 'mastered';
}

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

function contentHash(front: string, back: string): string {
  return createHash('sha256').update(`${front} ${back}`).digest('hex');
}

async function llmGenerateCards(
  cfg: HarnessConfig, slug: string, page: any, misconceptions: string[],
): Promise<{ front: string; back: string }[]> {
  const parts = [
    `Page: ${page?.meta?.title ?? slug}`,
    page?.body ? `Content:\n${page.body}` : '',
    misconceptions.length ? `Known misconceptions: ${misconceptions.join('; ')}` : '',
    CARD_PROMPT,
  ].filter(Boolean);
  const { output } = await generateText({
    model: modelFor('card_gen', cfg),
    prompt: parts.join('\n\n'),
    output: Output.object({ schema: cardsSchema }),
  });
  return output.cards;
}

/**
 * Pushes/updates Anki cards for every page the student has reached at least
 * effective `practicing` mastery on. Skips silently (returns zero counts,
 * never throws) when Anki isn't reachable — retried on the next scheduler
 * tick by the caller.
 */
export async function syncOutbound(
  lw: Engram,
  anki: AnkiClient,
  cfg: HarnessConfig,
  opts: { generateCards?: GenerateCards } = {},
): Promise<SyncOutboundResult> {
  const result: SyncOutboundResult = { pushed: 0, updated: 0, skipped: 0, failed: 0 };
  if (!(await anki.isUp())) return result; // Anki closed / connection refused — skip silently

  const generateCards: GenerateCards = opts.generateCards
    ?? ((slug, page, misconceptions) => llmGenerateCards(cfg, slug, page, misconceptions));

  const state = (await lw.call('get_student_state', { student: cfg.student })) as Record<
    string, { effective: string; misconceptions: string[] }
  >;
  const slugs = Object.entries(state)
    .filter(([, s]) => isKnown(s.effective))
    .map(([slug]) => slug);

  const ledger = readLedger(cfg.vault);

  for (const slug of slugs) {
    // Student evidence outlives its page — get_student_state still lists a slug whose page was
    // deleted, and read_page THROWS on a missing slug (lw.call rejects on an isError result). Left
    // unguarded this one call aborts the whole outbound run for every OTHER page too, the same way
    // a single bad card generation used to (see the try below). A page-less slug has nothing to turn
    // into cards, so skip it.
    const page = await lw.call('read_page', { slug }).then((r: any) => r?.page).catch(() => null);
    if (!page) continue; // page gone; skipped silently (skipped counts up-to-date CARDS, not this)
    const misconceptions = state[slug]?.misconceptions ?? [];
    // One page's bad generation must not abort the run for every other page — a live probe saw
    // card_gen emit unparseable output for one math-heavy page and the whole sync die.
    let cards: { front: string; back: string }[];
    try {
      cards = (await generateCards(slug, page, misconceptions)).slice(0, 4);
    } catch (e) {
      console.error(`[anki] card generation failed for ${slug}: ${(e as Error).message}`);
      result.failed++;
      continue;
    }
    if (cards.length === 0) continue;

    // The push to Anki is guarded for the same reason generation is (above) and read_page is
    // (below): AnkiConnect returns an error — thrown by client.invoke — for a single bad note, the
    // commonest being a duplicate front that addNote's `allowDuplicate: false` rejects. Unguarded,
    // that one throw aborts the WHOLE run, so every page ordered after the offending one goes
    // unsynced, and re-aborts at the same spot on every future tick. Isolate it to the one page.
    try {
      const domain = page.domain || 'general';
      const deck = `Engram::${domain}`;
      await anki.invoke('createDeck', { deck });

      const existingIds = Object.entries(ledger)
        .filter(([, v]) => v.slug === slug)
        .map(([id]) => id)
        .sort((a, b) => Number(a) - Number(b));

      for (let i = 0; i < cards.length; i++) {
        const { front, back } = cards[i];
        const hash = contentHash(front, back);
        const existingId = existingIds[i];

        if (existingId && ledger[existingId].hash === hash) {
          result.skipped++;
          continue;
        }

        if (existingId) {
          await anki.invoke('updateNoteFields', {
            note: { id: Number(existingId), fields: { Front: front, Back: back } },
          });
          ledger[existingId] = { slug, hash };
          result.updated++;
        } else {
          const noteId = await anki.invoke('addNote', {
            note: {
              deckName: deck,
              modelName: 'Basic',
              fields: { Front: front, Back: back },
              options: { allowDuplicate: false, duplicateScope: 'deck' },
              tags: [`engram::${slug}`],
            },
          });
          ledger[String(noteId)] = { slug, hash };
          result.pushed++;
        }
        writeLedger(cfg.vault, ledger); // persist after each push — crash-safe
      }
    } catch (e) {
      // Cards already pushed for this page stay pushed (their ledger writes persisted mid-loop);
      // this page counts as failed and the run moves on to the next.
      console.error(`[anki] push failed for ${slug}: ${(e as Error).message}`);
      result.failed++;
      continue;
    }
  }

  return result;
}
