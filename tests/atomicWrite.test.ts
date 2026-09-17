import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../src/server/atomicWrite.js';

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
});
