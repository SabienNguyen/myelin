import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../src/server/atomicWrite.js';

// Durability is not observable from a passing process — a missing fsync only shows up as a
// zero-length file after the power actually goes out. Recording the syscall order is the only way
// to pin the guarantee the header comment makes, so these two are deliberately white-box.
const { syscalls } = vi.hoisted(() => ({ syscalls: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    default: real,
    fsyncSync: (fd: number) => {
      syscalls.push('fsync');
      return real.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      syscalls.push('rename');
      return real.renameSync(from, to);
    },
  };
});

beforeEach(() => {
  syscalls.length = 0;
});

describe('atomicWrite', () => {
  it('writes the file and it reads back exactly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
    const p = join(dir, 'store.json');
    atomicWrite(p, '{"a":1}');
    expect(readFileSync(p, 'utf8')).toBe('{"a":1}');
  });

  it('creates a missing parent directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
    const p = join(dir, 'nested', 'deeper', 'store.json');
    atomicWrite(p, 'hello');
    expect(readFileSync(p, 'utf8')).toBe('hello');
  });

  it('a write whose writeFileSync throws mid-way leaves the previous file intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
    const p = join(dir, 'store.json');
    writeFileSync(p, 'original');

    // Make the directory read-only so the temp-file writeFileSync inside atomicWrite throws
    // before renameSync ever runs — the real path must be untouched by a write that never
    // completed.
    chmodSync(dir, 0o500);
    try {
      expect(() => atomicWrite(p, 'new content')).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(p, 'utf8')).toBe('original');
  });

  // credentials.json once stayed world-readable forever if it was first created loosely, because
  // an in-place rewrite ignores `mode`. Replacing the file makes the mode hold on every save.
  it.skipIf(process.platform === 'win32')('applies the mode even when a looser file already exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
    const p = join(dir, 'credentials.json');
    writeFileSync(p, 'old', { mode: 0o644 });
    atomicWrite(p, 'secret', 0o600);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readFileSync(p, 'utf8')).toBe('secret');
  });

  // Without this the graceful-read policy in the header is a lie: after power loss the rename can
  // be on disk while the bytes are not, the store reads back as "empty", and the next write
  // persists the emptiness as the learner's new history.
  it('flushes the temp file to disk BEFORE the rename publishes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
    atomicWrite(join(dir, 'store.json'), '{"a":1}');
    expect(syscalls).toContain('rename');
    expect(syscalls.indexOf('fsync')).toBeLessThan(syscalls.indexOf('rename'));
  });

  // A rename is not durable until the directory entry naming it is.
  it.skipIf(process.platform === 'win32')('flushes the parent directory after the rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
    atomicWrite(join(dir, 'store.json'), '{"a":1}');
    expect(syscalls).toEqual(['fsync', 'rename', 'fsync']);
  });

  // These stores sit inside the learner's Obsidian vault, where a leftover `store.json.tmp-1234`
  // shows up in the file explorer as a second, stale copy of their notes.
  it('leaves no .tmp sibling behind when the rename fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
    const p = join(dir, 'store.json');
    mkdirSync(p); // renaming a file onto an existing directory fails, after the temp file exists

    expect(() => atomicWrite(p, '{"a":1}')).toThrow();
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});
