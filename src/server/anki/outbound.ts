import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HarnessConfig } from '../config.js';
import { generateStructured } from '../llm/index.js';
import type { Engram } from '../mcp.js';
import { chatModelFor } from '../models.js';
import { recordUsage } from '../usageLedger.js';
import type { AnkiClient } from './client.js';
import { noteEntries, withAnkiLedger } from './ledger.js';

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

const cardsSchema = z.object({
  cards: z.array(z.object({ front: z.string(), back: z.string() })).max(4),
});

const CARD_PROMPT = 'Create at most 4 atomic flashcards for this page. Front = one precise question; '
  + 'Back = the answer in ≤ 2 sentences. If misconceptions are listed, make the FIRST card target the '
  + 'misconception directly.';

function isKnown(level: string): boolean {
  return level === 'practicing' || level === 'mastered';
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
  const { object, usage } = await generateStructured({
    model: chatModelFor('card_gen', cfg),
    prompt: parts.join('\n\n'),
    schema: cardsSchema, schemaName: 'cards',
  });
  recordUsage(cfg.vault, { role: 'card_gen', model: cfg.models?.card_gen?.model ?? 'unknown', usage });
  return object.cards;
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

  // The whole read-generate-push-write span runs under the shared mutex (anki/ledger.ts):
  // inbound's evidence-recording pass mutates the SAME file, and without one shared serialization
  // point a tick of each running concurrently could each read the pre-mutation ledger and the
  // loser's write would clobber the winner's.
  return withAnkiLedger(cfg.vault, async (ledger) => {
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

        const existingIds = noteEntries(ledger)
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
          // No per-push disk write here any more (withAnkiLedger writes once, on return): the
          // mutex now holds for the whole run, so a competing writer can no longer interleave and
          // there is nothing left for a mid-loop flush to protect against.
        }
      } catch (e) {
        // Cards already pushed for this page stay pushed IN THE LEDGER OBJECT (still written at
        // the end of this call); this page counts as failed and the run moves on to the next.
        console.error(`[anki] push failed for ${slug}: ${(e as Error).message}`);
        result.failed++;
        continue;
      }
    }

    return result;
  });
}

/**
 * The scheduler-facing entry point for the outbound half of Anki sync — same argument shape as
 * `syncInbound` (`lw, anki, cfg`), so index.ts's `ankiTick` can call this immediately after
 * `syncInbound` the same way it already calls that. `syncOutbound` has no OTHER production caller
 * today (H8 in the audit): nothing has ever written `anki-map.json`, so `syncInbound` early-returns
 * on every tick forever. Wiring this in is a follow-up task (T7b) — this export is what it calls.
 */
export function ankiOutboundTick(
  lw: Engram, anki: AnkiClient, cfg: HarnessConfig,
): Promise<SyncOutboundResult> {
  return syncOutbound(lw, anki, cfg);
}
