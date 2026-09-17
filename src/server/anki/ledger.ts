// The shared Anki sync ledger — vault/.harness/anki-map.json, one { noteId: {slug, hash} } map
// (inbound additionally keys a `_cursor` onto the same object). Both inbound.ts's syncInbound and
// outbound.ts's syncOutbound read this WHOLE file, mutate it across a long run of awaited
// AnkiConnect/MCP calls, and write it back. Read alone, that is the exact lost-update shape
// queueStore.ts's postmortem describes — except here it is two DIFFERENT modules racing the same
// file instead of one module racing itself, which a per-module mutex cannot fix. withAnkiLedger is
// the one choke point both go through, so an inbound tick and an outbound tick firing from the
// same cron minute (index.ts's ankiTick, once T7b wires the outbound side in) serialize onto the
// freshest on-disk state instead of clobbering each other's writes.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../atomicWrite.js';

export interface AnkiLedgerEntry {
  slug: string;
  hash: string;
}
export type AnkiLedger = Record<string, AnkiLedgerEntry> & { _cursor?: number };

function ledgerPath(vault: string): string {
  return join(vault, '.harness', 'anki-map.json');
}

/** The whole ledger. A torn or hand-edited file reads as empty — same graceful-read policy as
 *  every other store in this codebase — but SAYS SO on stderr first: this file is also read
 *  inside /api/status (via backlogDays), so a silent empty-read here would look like "never
 *  synced" instead of "the ledger is corrupt", and nobody would think to look at the file. */
export function readAnkiLedger(vault: string): AnkiLedger {
  const p = ledgerPath(vault);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as AnkiLedger;
  } catch (e) {
    console.error('[anki] ledger parse failed, treating as empty:', e instanceof Error ? e.message : e);
    return {};
  }
}

/** The ledger's card entries, with the `_cursor` bookkeeping key filtered out — both inbound
 *  (resolving noteId -> slug) and outbound (finding a slug's existing note ids) iterate the
 *  ledger's entries and neither wants to trip over `_cursor` there. */
export function noteEntries(ledger: AnkiLedger): [string, AnkiLedgerEntry][] {
  return Object.entries(ledger).filter(([k]) => k !== '_cursor') as [string, AnkiLedgerEntry][];
}

export function writeAnkiLedger(vault: string, ledger: AnkiLedger): void {
  atomicWrite(ledgerPath(vault), JSON.stringify(ledger, null, 2));
}

// One promise-chain "mutex" per vault path, the same shape as queueStore.updateQueue's `chains` —
// a single Node process is single-threaded, so a promise chain is all the serialization a
// same-process ledger needs.
const chains = new Map<string, Promise<unknown>>();

/**
 * The ONLY sanctioned way for production code (inbound or outbound) to read-modify-write the Anki
 * ledger. Queues onto this vault's mutex slot, re-reads the file fresh once every earlier-queued
 * caller has finished writing, hands `fn` a live ledger object to mutate in place, writes back
 * whatever `fn` returns alongside the mutated ledger, and releases the slot.
 *
 * Unlike queueStore's mutator, `fn` here IS allowed to be async and hold the ledger across awaits
 * — that is the whole point: inbound and outbound both need to mutate the ledger around long
 * AnkiConnect/MCP calls, and the mutex (not "never await while holding it") is what keeps that
 * safe, by making sure no OTHER caller's read-modify-write can interleave during that span.
 */
export function withAnkiLedger<T>(vault: string, fn: (ledger: AnkiLedger) => Promise<T>): Promise<T> {
  const prior = chains.get(vault) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(async () => {
    const ledger = readAnkiLedger(vault);
    const result = await fn(ledger);
    writeAnkiLedger(vault, ledger);
    return result;
  });
  chains.set(vault, next);
  return next;
}
