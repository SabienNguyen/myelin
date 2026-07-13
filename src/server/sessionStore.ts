import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

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
  writeFileSync(join(dir(vault), `${threadId}.json`), JSON.stringify(messages));
}
export function loadThread(vault: string, threadId: string): unknown[] {
  assertThreadId(threadId);
  const p = join(dir(vault), `${threadId}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
}
export function deleteThread(vault: string, threadId: string) {
  assertThreadId(threadId);
  const p = join(dir(vault), `${threadId}.json`);
  if (existsSync(p)) unlinkSync(p);
}

export type ThreadSummary = { id: string; title: string; updatedAt: string; messages: number };

const TITLE_MAX = 60;

/** Best-effort title: the first user message's first text part, trimmed. Falls back to the
 * thread id when there's no user text (e.g. an empty or assistant-only thread). */
function titleFor(messages: unknown[], id: string): string {
  const firstUser = (messages as any[]).find((m) => m && m.role === 'user');
  const text = firstUser?.parts?.find((p: any) => p?.type === 'text' && typeof p.text === 'string')?.text as
    | string
    | undefined;
  const trimmed = text?.trim();
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
