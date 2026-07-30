import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { dedupeById } from '../shared/messages.js';

const dir = (vault: string) => join(vault, '.harness', 'sessions');

// threadId is client-supplied and becomes a file name. Anything outside this
// allowlist (slashes, dots, empty, over-long) could escape .harness/sessions
// and violate the single-writer invariant — the harness may only write under
// vault/.harness/**.
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;
function assertThreadId(threadId: string) {
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
  // branch UI — so union-by-id loses nothing: messages the writer already knows keep the
  // writer's (fresher) version, and messages it has never seen are kept in front, matching the
  // usual case of a stale tab writing after another tab's turns. Order under truly interleaved
  // writers is best-effort; content survival is the guarantee.
  const incoming = dedupeById(messages);
  const incomingIds = new Set((incoming as any[]).map((m) => m?.id));
  const unseen = (loadThread(vault, threadId) as any[]).filter((m) => !incomingIds.has(m?.id));
  writeFileSync(join(dir(vault), `${threadId}.json`), JSON.stringify([...unseen, ...incoming]));
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
