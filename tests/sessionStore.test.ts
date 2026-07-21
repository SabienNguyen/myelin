import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveThread, loadThread, listThreads, deleteThread } from '../src/server/sessionStore.js';

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

describe('loadThread / saveThread — corrupt-file and duplicate-id hardening', () => {
  // Regression: a saved thread that (however it happened) contains two messages sharing an `id`
  // used to reach assistant-ui's MessageRepository unchanged, which throws "A message with the
  // same id already exists" while restoring and blanks the ENTIRE app at mount.

  it('loadThread dedupes messages with the same id, keeping the LAST occurrence, order preserved', () => {
    const vault = makeVault();
    const sessionsDir = join(vault, '.harness', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const onDisk = [
      { id: 'u1', v: 'first-copy' },
      { id: 'a1', v: 'only-a1' },
      { id: 'u1', v: 'second-copy' }, // duplicate of u1 — the more complete re-persist
    ];
    writeFileSync(join(sessionsDir, 'dupes.json'), JSON.stringify(onDisk));

    const loaded = loadThread(vault, 'dupes');
    expect(loaded).toEqual([
      { id: 'a1', v: 'only-a1' },
      { id: 'u1', v: 'second-copy' },
    ]);
  });

  it('loadThread returns [] for a file containing invalid JSON, instead of throwing', () => {
    const vault = makeVault();
    const sessionsDir = join(vault, '.harness', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'broken.json'), '{not valid json');

    expect(loadThread(vault, 'broken')).toEqual([]);
  });

  it('loadThread returns [] for a file containing a JSON object (non-array)', () => {
    const vault = makeVault();
    const sessionsDir = join(vault, '.harness', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'notarray.json'), JSON.stringify({ oops: 'this is an object' }));

    expect(loadThread(vault, 'notarray')).toEqual([]);
  });

  it('saveThread dedupes duplicate ids before writing, so the file on disk is already clean', () => {
    const vault = makeVault();
    saveThread(vault, 'willdupe', [
      { id: 'u1', v: 'stale' },
      { id: 'u1', v: 'fresh' },
      { id: 'a1', v: 'unique' },
    ]);

    const onDisk = JSON.parse(readFileSync(join(vault, '.harness', 'sessions', 'willdupe.json'), 'utf8'));
    expect(onDisk).toEqual([
      { id: 'u1', v: 'fresh' },
      { id: 'a1', v: 'unique' },
    ]);
  });
});

describe('listThreads', () => {
  it('returns [] when no sessions dir exists yet', () => {
    const vault = makeVault();
    expect(listThreads(vault)).toEqual([]);
  });

  it('titles from the first user message text, newest first, skipping a corrupt file', () => {
    const vault = makeVault();
    saveThread(vault, 'older', [{ role: 'user', parts: [{ type: 'text', text: 'What is a derivative?' }] }]);
    const olderPath = join(vault, '.harness', 'sessions', 'older.json');
    const past = new Date(Date.now() - 60_000);
    utimesSync(olderPath, past, past);

    saveThread(vault, 'newer', [
      { role: 'assistant', parts: [{ type: 'text', text: 'ignored, not a user message' }] },
      { role: 'user', parts: [{ type: 'text', text: 'Help me with fractions' }] },
    ]);
    writeFileSync(join(vault, '.harness', 'sessions', 'corrupt.json'), '{not json');

    const threads = listThreads(vault);
    expect(threads.map((t) => t.id)).toEqual(['newer', 'older']);
    expect(threads[0].title).toBe('Help me with fractions');
    expect(threads[0].messages).toBe(2);
    expect(threads[1].title).toBe('What is a derivative?');
    expect(threads.some((t) => t.id === 'corrupt')).toBe(false);
    expect(new Date(threads[0].updatedAt).getTime()).toBeGreaterThan(new Date(threads[1].updatedAt).getTime());
  });

  it('falls back to the thread id when there is no user text', () => {
    const vault = makeVault();
    saveThread(vault, 'no-user-text', []);
    const threads = listThreads(vault);
    expect(threads[0].title).toBe('no-user-text');
  });

  it('trims long titles to ~60 chars', () => {
    const vault = makeVault();
    saveThread(vault, 'longone', [{ role: 'user', parts: [{ type: 'text', text: 'x'.repeat(120) }] }]);
    const threads = listThreads(vault);
    expect(threads[0].title.length).toBeLessThanOrEqual(61);
  });
});

describe('deleteThread', () => {
  it('removes a valid thread file', () => {
    const vault = makeVault();
    saveThread(vault, 'todelete', [{ id: 'u1' }]);
    deleteThread(vault, 'todelete');
    expect(existsSync(join(vault, '.harness', 'sessions', 'todelete.json'))).toBe(false);
  });

  it('rejects an invalid threadId and touches nothing', () => {
    const vault = makeVault();
    expect(() => deleteThread(vault, '../pages/target')).toThrow(/threadId/);
    expect(readFileSync(join(vault, 'pages', 'target.md'), 'utf8')).toMatch(/never be touched/);
  });

  it('is a no-op for a missing (but validly-named) thread', () => {
    const vault = makeVault();
    expect(() => deleteThread(vault, 'doesnotexist')).not.toThrow();
  });
});
