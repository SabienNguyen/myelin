import { describe, it, expect } from 'vitest';
import { repairSlug, sanitizeToolArgs } from '../src/server/session.js';

const SLUGS = ['derivatives', 'chain-rule', 'gradient-descent', 'loss-functions', 'ser-vs-estar'];

describe('repairSlug', () => {
  it('keeps exact and unknown-but-distant slugs', () => {
    expect(repairSlug('derivatives', SLUGS)).toBe('derivatives');
    expect(repairSlug('quantum-fields', SLUGS)).toBe('quantum-fields'); // no silent wrong match
  });
  it('repairs hallucinated variants', () => {
    expect(repairSlug('derivative', SLUGS)).toBe('derivatives');          // missing plural
    expect(repairSlug('derivatives-introduction', SLUGS)).toBe('derivatives'); // invented suffix
    expect(repairSlug('Chain Rule', SLUGS)).toBe('chain-rule');           // title-cased
  });
  it('feeds repair through sanitizeToolArgs for slug tools only', () => {
    expect(sanitizeToolArgs({ slug: 'derivative', kind: 'exposed', note: '' },
      'record_evidence', 'sabien', SLUGS).slug).toBe('derivatives');
    expect(sanitizeToolArgs({ query: 'derivative' }, 'search', 'sabien', SLUGS).query).toBe('derivative');
  });
});

describe('sanitizeToolArgs (MCP tool guard)', () => {
  it('strips null and undefined optional fields', () => {
    expect(sanitizeToolArgs(
      { slug: 'derivatives', kind: 'applied-correctly', note: 'ok', misconception: null },
      'record_evidence', 'sabien',
    )).toEqual({ slug: 'derivatives', kind: 'applied-correctly', note: 'ok', student: 'sabien' });
  });
  it('forces the configured student id on student-scoped tools', () => {
    expect(sanitizeToolArgs({ student: 'student', slug: 'x', kind: 'exposed', note: '' },
      'record_evidence', 'sabien').student).toBe('sabien');
    expect(sanitizeToolArgs({ student: 'wrong' }, 'next_lessons', 'sabien').student).toBe('sabien');
  });
  it('leaves non-student tools and non-object args alone', () => {
    expect(sanitizeToolArgs({ slug: 'x' }, 'read_page', 'sabien')).toEqual({ slug: 'x' });
    expect(sanitizeToolArgs(undefined, 'read_page', 'sabien')).toBeUndefined();
  });

  // T43: the standing `misconceptions[]` array — what the graph ⚠ marker, session-plan repair
  // queue, and page panel read — is populated only by record_evidence's `misconception` param,
  // while the tutor prompt teaches "kind misconception, the confusion verbatim in the note".
  // Without this defaulting, a tutor following its own instructions records evidence no surface
  // can show.
  it('defaults misconception from the note when kind is misconception', () => {
    const clean = sanitizeToolArgs(
      { slug: 'derivatives', kind: 'misconception', note: 'thinks dx is a factor' },
      'record_evidence', 'sabien',
    );
    expect(clean.misconception).toBe('thinks dx is a factor');
  });
  it('an explicit misconception param wins over the note', () => {
    const clean = sanitizeToolArgs(
      { slug: 'derivatives', kind: 'misconception', note: 'quiz 0/3', misconception: 'reads d/dx as a fraction' },
      'record_evidence', 'sabien',
    );
    expect(clean.misconception).toBe('reads d/dx as a fraction');
  });
  it('never invents a misconception for other kinds', () => {
    expect(sanitizeToolArgs(
      { slug: 'derivatives', kind: 'struggled', note: 'quiz 0/3' },
      'record_evidence', 'sabien',
    ).misconception).toBeUndefined();
  });
});
