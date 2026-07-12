import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
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
export function logGuardrail(vault: string, entry: string) {
  mkdirSync(join(vault, '.harness'), { recursive: true });
  appendFileSync(join(vault, '.harness', 'guardrail.log'), `${new Date().toISOString()} ${entry}\n`);
}
