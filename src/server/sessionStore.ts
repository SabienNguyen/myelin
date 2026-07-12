import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = (vault: string) => join(vault, '.harness', 'sessions');

export function saveThread(vault: string, threadId: string, messages: unknown[]) {
  mkdirSync(dir(vault), { recursive: true });
  writeFileSync(join(dir(vault), `${threadId}.json`), JSON.stringify(messages));
}
export function loadThread(vault: string, threadId: string): unknown[] {
  const p = join(dir(vault), `${threadId}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
}
export function logGuardrail(vault: string, entry: string) {
  mkdirSync(join(vault, '.harness'), { recursive: true });
  appendFileSync(join(vault, '.harness', 'guardrail.log'), `${new Date().toISOString()} ${entry}\n`);
}
