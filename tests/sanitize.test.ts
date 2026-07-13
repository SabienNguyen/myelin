import { describe, it, expect } from 'vitest';
import { sanitizeToolArgs } from '../src/server/session.js';

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
});
