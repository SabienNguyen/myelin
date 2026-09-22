import { mkdirSync, readFileSync, appendFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './atomicWrite.js';
import { dedupeById } from '../shared/messages.js';

const dir = (vault: string) => join(vault, '.harness', 'sessions');

// threadId is client-supplied and becomes a file name. Anything outside this
// allowlist (slashes, dots, empty, over-long) could escape .harness/sessions
// and violate the single-writer invariant — the harness may only write under
// vault/.harness/**.
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function assertThreadId(threadId: string) {
  if (!THREAD_ID.test(threadId)) {
    throw new Error(`invalid threadId ${JSON.stringify(threadId)}: must match ${THREAD_ID}`);
  }
}

export function saveThread(vault: string, threadId: string, messages: unknown[]) {
  assertThreadId(threadId);
  mkdirSync(dir(vault), { recursive: true });
  // Merge with what's on disk instead of replacing it. Two tabs on the same thread each write
  // their own view; a blind replace let the staler tab silently erase the other's entire
  // exchange (found by a live two-tab probe). Threads only grow — there is no message-edit or
  // branch UI — so union-by-id loses nothing.
  //
  // DISK ORDER WINS. This used to write [unseen, ...incoming], putting anything the writer had
  // not seen in FRONT, and that reorders a conversation whenever a writer lands late: a turn
  // holding only its own two messages saved after the learner had asked something else, and the
  // newer exchange jumped ahead of the older one — a transcript reading "what is a decorator?"
  // before the question asked minutes earlier. A merge that can reorder recorded history is worse
  // than one that occasionally appends in an odd place, so: keep the file's order, let the writer
  // refresh messages it also knows about IN PLACE, and append only genuinely new ones at the end.
  //
  // Only a STRING id identifies a message, exactly as dedupeById defines it. Both writers hand
  // this unvalidated client JSON (chatRoute's POST body and its PUT body), and shared/messages.ts
  // supports id-less messages, so `undefined` used to be a real map key here: every id-less
  // message in one write collapsed onto the last of them, and an id-less message already on disk
  // was overwritten by whichever id-less message the writer happened to send — the exact erasure
  // this merge exists to prevent, on the one artifact the learner cannot regenerate. An id-less
  // message is therefore never matched against anything; it is kept where it is and appended
  // unconditionally. That can duplicate one, which is visible in the transcript and recoverable.
  // Losing it is neither.
  const incoming = dedupeById(messages) as any[];
  const idOf = (m: any): string | undefined => (typeof m?.id === 'string' ? m.id : undefined);
  const byId = new Map<string, any>();
  for (const m of incoming) {
    const id = idOf(m);
    if (id !== undefined) byId.set(id, m);
  }
  const onDisk = loadThread(vault, threadId) as any[];
  const seen = new Set<string>();
  const merged: any[] = [];
  for (const m of onDisk) {
    const id = idOf(m);
    if (id === undefined) {
      merged.push(m);
      continue;
    }
    merged.push(byId.get(id) ?? m); // fresher version if the writer has one, same position
    seen.add(id);
  }
  for (const m of incoming) {
    const id = idOf(m);
    if (id === undefined || !seen.has(id)) merged.push(m);
  }
  atomicWrite(join(dir(vault), `${threadId}.json`), JSON.stringify(merged));
}
/** Restores a persisted thread. A corrupt file (invalid JSON, or JSON that isn't an array) must
 * never 500 the GET — it's treated as an empty thread instead. Deduped by id as a durable
 * backstop: a saved thread with a duplicate id would otherwise blank the entire app at mount
 * (assistant-ui's MessageRepository throws restoring two messages with the same id). */
export function loadThread(vault: string, threadId: string): unknown[] {
  assertThreadId(threadId);
  const p = join(dir(vault), `${threadId}.json`);
  if (!existsSync(p)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return dedupeById(parsed);
}
export function deleteThread(vault: string, threadId: string) {
  assertThreadId(threadId);
  const p = join(dir(vault), `${threadId}.json`);
  if (existsSync(p)) unlinkSync(p);
  // A thread's compaction blocks are keyed by message id, and a new thread created under the
  // same id would hold none of those ids — historyCompaction drops stale blocks on its own, but
  // leaving the file behind would keep a deleted conversation's summary on disk.
  const c = join(vault, '.harness', 'compaction', `${threadId}.json`);
  if (existsSync(c)) unlinkSync(c);
}

export type ThreadSummary = { id: string; title: string; updatedAt: string; messages: number };

const TITLE_MAX = 60;

/** Best-effort title: the first SUBSTANTIVE user text (≥ 12 chars) — "hi" openers make
 * indistinguishable rows in the picker, so prefer the message that says what the conversation
 * is about. Falls back to the first user text of any length, then the thread id. */
function titleFor(messages: unknown[], id: string): string {
  const userTexts = (messages as any[])
    .filter((m) => m && m.role === 'user')
    .map((m) => m.parts?.find((p: any) => p?.type === 'text' && typeof p.text === 'string')?.text?.trim())
    .filter((t): t is string => !!t);
  const trimmed = userTexts.find((t) => t.length >= 12) ?? userTexts[0];
  if (!trimmed) return id;
  return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX)}…` : trimmed;
}

/** Scan vault/.harness/sessions/*.json for a thread-picker list. Skips any file that isn't a
 * valid persisted thread (corrupt JSON, not an array) rather than failing the whole listing. */
export function listThreads(vault: string): ThreadSummary[] {
  const d = dir(vault);
  if (!existsSync(d)) return [];
  const threads: ThreadSummary[] = [];
  for (const file of readdirSync(d)) {
    if (!file.endsWith('.json')) continue;
    const full = join(d, file);
    try {
      const messages = JSON.parse(readFileSync(full, 'utf8'));
      if (!Array.isArray(messages)) continue;
      const id = file.slice(0, -'.json'.length);
      threads.push({
        id,
        title: titleFor(messages, id),
        updatedAt: statSync(full).mtime.toISOString(),
        messages: messages.length,
      });
    } catch {
      continue; // unparseable file — skip, don't fail the whole listing
    }
  }
  threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return threads;
}

export function logGuardrail(vault: string, entry: string) {
  mkdirSync(join(vault, '.harness'), { recursive: true });
  appendFileSync(join(vault, '.harness', 'guardrail.log'), `${new Date().toISOString()} ${entry}\n`);
}
