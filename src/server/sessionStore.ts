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

/** asideRoute.ts persists a `data-aside` part on a message DIRECTLY (addPartToMessage below),
 *  outside the request that produced the message it anchors to. A later client save of that same
 *  message — built from a browser snapshot taken before the aside landed — carries no such part,
 *  and saveThread's ordinary "incoming replaces disk, same position" rule would silently drop it:
 *  the learner's aside answer would vanish the next time either tab saved. Parts are matched by
 *  their own `id`, not by position, so an aside added after the incoming copy was snapshotted is
 *  exactly the case this restores. */
function keepAsideParts(onDiskMsg: any, incomingMsg: any): any {
  const onDiskParts: any[] = Array.isArray(onDiskMsg?.parts) ? onDiskMsg.parts : [];
  const asideOnDisk = onDiskParts.filter((p) => p?.type === 'data-aside');
  if (asideOnDisk.length === 0) return incomingMsg;
  const incomingParts: any[] = Array.isArray(incomingMsg?.parts) ? incomingMsg.parts : [];
  const incomingAsideIds = new Set(
    incomingParts.filter((p) => p?.type === 'data-aside').map((p) => p?.id),
  );
  const missing = asideOnDisk.filter((p) => !incomingAsideIds.has(p?.id));
  if (missing.length === 0) return incomingMsg;
  return { ...incomingMsg, parts: [...incomingParts, ...missing] };
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
    const incomingMsg = byId.get(id);
    // fresher version if the writer has one, same position — but never at the cost of a
    // `data-aside` part (see keepAsideParts below).
    merged.push(incomingMsg ? keepAsideParts(m, incomingMsg) : m);
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

/** Persists one part (e.g. an aside's `data-aside` result) onto a specific message, outside the
 * normal chat-turn save. Writes straight to disk rather than through saveThread's merge: this is
 * the AUTHORITATIVE copy of the part, minted after the message it anchors to already exists, so
 * there is nothing to merge it against — a same-id part already on the message is replaced
 * (asking twice about the same aside updates it in place), everything else is kept. */
export function addPartToMessage<P extends { type: string; id?: unknown }>(
  vault: string, threadId: string, messageId: string, part: P,
): void {
  assertThreadId(threadId);
  const messages = loadThread(vault, threadId) as any[];
  const idx = messages.findIndex((m) => m?.id === messageId);
  if (idx === -1) {
    throw new Error(`no message "${messageId}" in thread "${threadId}"`);
  }
  const parts: any[] = Array.isArray(messages[idx].parts) ? messages[idx].parts : [];
  const kept = parts.filter((p) => !(part.id !== undefined && p?.id === part.id));
  messages[idx] = { ...messages[idx], parts: [...kept, part] };
  mkdirSync(dir(vault), { recursive: true });
  atomicWrite(join(dir(vault), `${threadId}.json`), JSON.stringify(messages));
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
