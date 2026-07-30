// The compile-queue ledger's ONLY storage primitives — vault/.harness/compile-queue.json.
// Everything that touches this file on disk (ingest.ts, ingestRepo.ts) goes through this module so
// there is exactly one serialization mechanism to reason about.
//
// THE BUG THIS MODULE FIXES (postmortem, 2026-07-21 ~19:00): every ledger write used to be a
// read-modify-write pair hand-rolled at each call site — `const ledger = readQueue(vault); ...
// ledger.push(x)/mutate(x)...; writeQueue(vault, ledger)`. That is safe ONLY when nothing async
// happens between the read and the write, because Node never preempts synchronous code — no other
// ledger writer can interleave without an explicit await point. compileNext/compileOne broke that
// invariant: compileNext read the ledger ONCE, then handed that same array to compileOne, which
// mutates its claimed entry and (in a `finally`) writes the WHOLE array back — but only after
// awaiting a real LLM call that can run for a long time. Any row another flow appended to the file
// during that window (ingestRepo's docs pass, a concurrent startConversion) was invisible to the
// stale in-memory array, and got silently erased the moment compileOne's finally block fired. That
// is exactly how a repo ingest's placeholder + 14 doc-chapter entries were lost while a long-running
// compile drain was processing other entries.
//
// The fix: no call site is allowed to hold a `QueueEntry[]` across an await and write it back later.
// updateQueue is the only sanctioned mutation path — it re-reads the file FRESH, inside a per-vault
// mutex slot, immediately before applying a synchronous mutator and writing the result. Because the
// mutator itself cannot be async, there is no "stale array held across an await" to hold in the
// first place, and the mutex means concurrent updateQueue callers still serialize onto the freshest
// on-disk state rather than clobbering each other.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type QueueStatus = 'converting' | 'convert-error' | 'pending' | 'compiling' | 'done' | 'error';
export interface QueueEntry {
  book: string;
  chapter: string; // vault-relative path, e.g. 'raw/uploads/<book-slug>/ch-01-....md' — this
  // doubles as each entry's identity key across the whole ledger (placeholders use a synthetic
  // `__converting__/<ts>` / `__ingesting_repo__/<ts>` chapter instead of a real file path, for the
  // same reason: it's guaranteed unique). updateQueue's targeted mutators all key off it.
  title: string;
  status: QueueStatus;
  error?: string;
  startedAt?: string; // ISO — set on 'converting' placeholders so the UI can show elapsed time
  progress?: { pagesDone: number; pagesTotal: number | null }; // set on 'converting' placeholders
  sourceUrl?: string; // papers: the URL the document was fetched from — cited on compiled pages
  // B2c (ingestRepo.ts): marks the single placeholder entry a repo ingest owns for its whole
  // lifetime (cloning -> docs pass -> mining pass -> sidecar refresh -> seeding). Per-chapter
  // entries queued by the docs pass are plain book chapters (no `mode`) — they compile through the
  // existing, unmodified pipeline exactly like a book's.
  mode?: 'repo';
  // Human-readable phase text for a `mode: 'repo'` placeholder ('cloning', 'docs: N queued',
  // 'mining…', 'mined P/C passed', the final 'pages: N queued, exercises: P' summary) — the repo
  // analogue of `progress` above, which is shaped for page-count conversion progress and doesn't
  // fit a multi-phase repo ingest.
  phase?: string;
}

function ledgerPath(vault: string): string {
  return join(vault, '.harness', 'compile-queue.json');
}

/** The full compile queue ledger — a pure reader, safe to call any time from anywhere (ingest REST
 * routes, tests, updateQueue's own mutator below). Never pair this with a later writeQueue call
 * yourself in production code — see updateQueue.
 *
 * "Safe to call any time from anywhere" is a real contract: readQueue runs on a chat turn
 * (session.ts's goal detection) and inside updateQueue's mutex, so a raw JSON.parse throw here does
 * not stay contained — it 500s the learner's conversation and wedges every queue mutation until the
 * file is hand-repaired. A machine-written bookkeeping ledger truncated by a crash mid-write, a
 * disk-full, or a manual edit must therefore degrade to "empty queue" (updateQueue then rewrites a
 * clean ledger from the still-present raw/ sources), the same graceful-read the goal and generated
 * -exercise stores already use — not fail loud like a user-authored config. */
export function readQueue(vault: string): QueueEntry[] {
  const p = ledgerPath(vault);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? (parsed as QueueEntry[]) : [];
  } catch {
    return [];
  }
}

/** Low-level whole-array writer — a synchronous writeFileSync, so no interleaved partial writes.
 * NOT serialized against updateQueue and NOT itself safe for read-modify-write: pairing it with an
 * earlier readQueue call that crossed an await is precisely the lost-update bug this module exists
 * to close (see the module doc comment above). Kept exported for two reasons only: (1) offline
 * repair/migration scripts operating against a quiescent vault (no server running), and (2) the two
 * call sites in ingest.ts/ingestRepo.ts (startConversion, ingestRepo) whose initial placeholder push
 * must be durably on disk the instant those (synchronous-returning) functions return — safe there
 * specifically because nothing async happens between their read and write. Every OTHER production
 * mutation goes through updateQueue. */
export function writeQueue(vault: string, ledger: QueueEntry[]): void {
  mkdirSync(join(vault, '.harness'), { recursive: true });
  writeFileSync(ledgerPath(vault), JSON.stringify(ledger, null, 2));
}

// ── serialized mutation ─────────────────────────────────────────────────────────────────────

/** One promise-chain "mutex" per vault path — a single Node process is single-threaded, so a
 * promise chain is all the serialization a same-process ledger needs (across-process safety is a
 * non-goal here, same as before this fix). Keyed by vault so unrelated vaults (multiple per test
 * file) never wait on each other. */
const chains = new Map<string, Promise<unknown>>();

/**
 * The ONLY sanctioned way for production code to mutate the ledger. Queues onto this vault's mutex
 * slot, then — once every earlier-queued mutation has finished writing — re-reads the file fresh,
 * hands the mutator a live array to inspect/patch/push/filter, writes back whatever it returns (or
 * the same array, mutated in place, if the mutator returns void), and releases the slot.
 *
 * The mutator is deliberately synchronous: since the read happens INSIDE the mutex slot, right
 * before the mutator runs, and the mutator can't itself await anything, there is no window in which
 * a call site could be holding a stale array across an await — the read is always the very last
 * thing that happened before the write. That's the whole fix. Find-and-patch an existing entry by
 * its `chapter` identity, `entries.push(...)` new rows, or `return entries.filter(...)` to remove
 * placeholders — all three styles are used across ingest.ts/ingestRepo.ts.
 *
 * A throwing mutator rejects only its own caller's promise; the chain still advances (via the
 * trailing `.catch`) so one bad mutation never wedges every later caller against this vault.
 */
/**
 * Append chapter entries, UPSERTING by chapter path: any existing row with the same `chapter` is
 * removed first, so re-ingesting a source (or two ingests racing to the same path) leaves exactly
 * one entry per chapter. This is load-bearing, not tidiness — `chapter` is the ledger's identity
 * key (see QueueEntry), and every status mutator finds its target with
 * `entries.find(e => e.chapter === …)`. A duplicate chapter row therefore can NEVER be marked
 * done: the find always resolves to the first match, so the later duplicate is stranded 'pending'
 * forever and ensureCompileDrain's `while (some pending)` loop recompiles it without end — a fresh
 * vault filled with thousands of pages before this was caught. Placeholders (synthetic unique
 * chapters) never collide, so this is a no-op for them.
 */
export function enqueueChapters(entries: QueueEntry[], additions: QueueEntry[]): void {
  const incoming = new Set(additions.map((e) => e.chapter));
  for (let i = entries.length - 1; i >= 0; i--) {
    if (incoming.has(entries[i].chapter)) entries.splice(i, 1);
  }
  entries.push(...additions);
}

export function updateQueue(
  vault: string,
  mutator: (entries: QueueEntry[]) => QueueEntry[] | void,
): Promise<QueueEntry[]> {
  const prior = chains.get(vault) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(() => {
    const entries = readQueue(vault);
    const result = mutator(entries) ?? entries;
    writeQueue(vault, result);
    return result;
  });
  chains.set(vault, next);
  return next;
}
