import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGoal, writeGoal, pathProgress } from '../src/server/goalStore.js';

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'goal-test-'));
});

describe('goalStore — the active goal', () => {
  it('round-trips a path goal and stamps the date', () => {
    const stored = writeGoal(vault, { kind: 'path', slug: 'music-theory' }, new Date('2026-07-25T10:00:00Z'));
    expect(stored).toEqual({ kind: 'path', slug: 'music-theory', setOn: '2026-07-25' });
    expect(readGoal(vault)).toEqual(stored);
  });
  it('returns null when no goal has ever been set', () => {
    expect(readGoal(vault)).toBeNull();
  });
  it('clears with null', () => {
    writeGoal(vault, { kind: 'page', slug: 'derivatives' });
    expect(readGoal(vault)).not.toBeNull();
    expect(writeGoal(vault, null)).toBeNull();
    expect(readGoal(vault)).toBeNull();
  });
  it('rejects a slug that fails the allowlist', () => {
    // The slug is interpolated into MCP tool arguments, so it is validated at the boundary rather
    // than trusted — same reasoning as sessionStore's THREAD_ID.
    expect(() => writeGoal(vault, { kind: 'path', slug: '../../etc/passwd' })).toThrow(/invalid goal slug/);
    expect(() => writeGoal(vault, { kind: 'path', slug: 'Has Capitals' })).toThrow(/invalid goal slug/);
  });
  it('accepts a long title-derived slug — the pointer must not be tighter than the page it names', () => {
    // slugify caps nothing; "Introduction to the Fundamental Theorem of Calculus…" is 83 chars, and
    // write_page happily creates that page. The old 64-char goal cap then 400'd on setting it as a
    // goal — a page you could make but not aim at. The character class is still enforced.
    const long = 'introduction-to-the-fundamental-theorem-of-calculus-and-its-applications-in-physics';
    expect(long.length).toBeGreaterThan(64);
    expect(writeGoal(vault, { kind: 'page', slug: long })?.slug).toBe(long);
    expect(readGoal(vault)?.slug).toBe(long);
    // still bounded (filesystem filename limit) and still character-class-checked regardless of length
    expect(() => writeGoal(vault, { kind: 'page', slug: 'a'.repeat(300) })).toThrow(/invalid goal slug/);
    expect(() => writeGoal(vault, { kind: 'page', slug: `${'a'.repeat(80)}/../../etc` })).toThrow(/invalid goal slug/);
  });
  // /api/graph reads the goal, and that payload previously needed no vault — a partial config must
  // degrade to "no goal" rather than 500 the endpoint.
  it('returns null for a missing or empty vault path instead of throwing', () => {
    expect(readGoal(undefined as any)).toBeNull();
    expect(readGoal('')).toBeNull();
  });
  it('treats a corrupt or malformed goal file as no goal, never throwing', () => {
    // A bad goal must not take down bootstrap — "no goal" is a valid state, a crashed session is not.
    mkdirSync(join(vault, '.harness'), { recursive: true });
    for (const body of ['not json at all', '{"kind":"nonsense","slug":"x"}', '{"kind":"path"}', '{"kind":"path","slug":"../x"}']) {
      writeFileSync(join(vault, '.harness', 'goal.json'), body);
      expect(readGoal(vault)).toBeNull();
    }
  });
});

describe('pathProgress — decay-aware syllabus progress', () => {
  const path = { slug: 'p', title: 'Path', pages: ['a', 'b', 'c'] };

  it('counts practicing and mastered as known, and resumes at the first gap', () => {
    const p = pathProgress(path, {
      a: { effective: 'mastered' }, b: { effective: 'exposed' }, c: { effective: 'practicing' },
    });
    expect(p).toMatchObject({ known: 2, total: 3, nextSlug: 'b' });
  });
  it('treats an absent page as unseen', () => {
    expect(pathProgress(path, {})).toMatchObject({ known: 0, total: 3, nextSlug: 'a' });
  });
  it('reports complete with no next step', () => {
    const all = { a: { effective: 'mastered' }, b: { effective: 'mastered' }, c: { effective: 'practicing' } };
    expect(pathProgress(path, all)).toMatchObject({ known: 3, total: 3, nextSlug: null });
  });
  // The whole point of reading EFFECTIVE rather than raw level: a page whose mastery has decayed
  // must stop counting toward the path, so progress can go down as well as up.
  it('does not credit a page whose effective level has decayed below practicing', () => {
    const decayed = pathProgress(path, {
      a: { effective: 'exposed' },   // raw level may still say mastered; effective is what counts
      b: { effective: 'mastered' }, c: { effective: 'mastered' },
    });
    expect(decayed).toMatchObject({ known: 2, nextSlug: 'a' });
  });
  it('handles an empty path without dividing by zero', () => {
    expect(pathProgress({ slug: 'e', title: 'E', pages: [] }, {}))
      .toMatchObject({ known: 0, total: 0, nextSlug: null });
  });
});
