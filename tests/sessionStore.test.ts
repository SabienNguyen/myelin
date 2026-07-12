import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveThread, loadThread } from '../src/server/sessionStore.js';

const makeVault = () => {
  const vault = mkdtempSync(join(tmpdir(), 'lwh-vault-'));
  mkdirSync(join(vault, 'pages'), { recursive: true });
  writeFileSync(join(vault, 'pages', 'target.md'), 'vault page — must never be touched by the harness');
  return vault;
};

describe('sessionStore threadId validation (single-writer invariant)', () => {
  it('rejects path-traversal threadIds in saveThread and writes nothing outside .harness/sessions', () => {
    const vault = makeVault();
    expect(() => saveThread(vault, '../evil', [{ hi: true }])).toThrow(/threadId/);
    expect(() => saveThread(vault, '../pages/target', [])).toThrow(/threadId/);
    expect(existsSync(join(vault, 'evil.json'))).toBe(false);
    expect(existsSync(join(vault, '.harness', 'evil.json'))).toBe(false);
    // the vault page is untouched
    expect(readFileSync(join(vault, 'pages', 'target.md'), 'utf8')).toMatch(/never be touched/);
  });

  it('rejects traversal, separators, and over-long ids in loadThread too', () => {
    const vault = makeVault();
    expect(() => loadThread(vault, '../pages/target.md')).toThrow(/threadId/);
    expect(() => loadThread(vault, 'a/b')).toThrow(/threadId/);
    expect(() => loadThread(vault, '')).toThrow(/threadId/);
    expect(() => loadThread(vault, 'x'.repeat(65))).toThrow(/threadId/);
  });

  it('still round-trips a valid threadId', () => {
    const vault = makeVault();
    saveThread(vault, 'default_thread-1', [{ id: 'u1' }]);
    expect(loadThread(vault, 'default_thread-1')).toEqual([{ id: 'u1' }]);
    expect(existsSync(join(vault, '.harness', 'sessions', 'default_thread-1.json'))).toBe(true);
  });
});
