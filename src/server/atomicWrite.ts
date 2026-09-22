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
//
// The two fsyncs are what extend that from "survives a process kill" to "survives POWER LOSS",
// which is what the paragraph above actually needs. Without the file fsync the rename can reach
// the platter before the bytes do, and the machine comes back holding a zero-length file at the
// real path — exactly the "empty" the graceful read then persists as truth. Without the directory
// fsync the bytes are durable but the directory entry naming them is not, so the recovered
// directory can still point at the old inode or at nothing.
//
// NOT guaranteed on Windows: a directory cannot be opened for fsync there, so the rename itself
// can be lost after power loss even though the new file's contents cannot.
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** `mode` is for secrets (credentials.json, settings.json). The temp file is always freshly
 *  created, so unlike an in-place rewrite the mode applies on every save, not just the first. */
export function atomicWrite(path: string, text: string, mode?: number): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  try {
    const fd = openSync(tmpPath, 'w', mode);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, path);
    fsyncDir(dir);
  } catch (err) {
    // These stores live inside the learner's Obsidian vault. A write that fails after the temp
    // file exists must not leave `<name>.tmp-1234` sitting next to the real file, where it shows
    // up in Obsidian's file explorer as a second, stale copy of their notes.
    try {
      unlinkSync(tmpPath);
    } catch {
      // The cleanup failing (already renamed, read-only dir) must not mask why the write failed.
    }
    throw err;
  }
}

function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return; // openSync on a directory fails there — see header
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
