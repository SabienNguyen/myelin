// Every store in this codebase reads its file back gracefully — a corrupt or truncated JSON file
// is treated as "empty", not a thrown error (queueStore's readQueue, goalStore's readGoal, and the
// rest all follow this rule so a bad sidecar never 500s a chat turn). That graceful-read policy
// only stays safe if the file it is reading is never HALF-WRITTEN: a plain `writeFileSync` that
// dies partway through (process kill, disk full, power loss) leaves a torn file on disk, the next
// read sees "empty" instead of "corrupt", and the very next write persists that empty state as the
// new truth — silently erasing everything the file held. `atomicWrite` closes that window: it
// writes to a sibling temp file first (so a crash mid-write leaves the ORIGINAL file untouched,
// not the target path) and only `renameSync`s over the real path once the write has fully
// completed. `renameSync` on the same filesystem is atomic at the OS level, so a reader can never
// observe a half-written result.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** `mode` is for secrets (credentials.json, settings.json). The temp file is always freshly
 *  created, so unlike an in-place rewrite the mode applies on every save, not just the first. */
export function atomicWrite(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, text, mode === undefined ? undefined : { mode });
  renameSync(tmpPath, path);
}
