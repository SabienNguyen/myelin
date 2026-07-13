import { describe, it, expect } from 'vitest';
import { splitChapters } from '../src/server/convert.js';

describe('splitChapters', () => {
  it('splits on H1 headings', () => {
    const md = [
      '# Chapter One',
      'Intro text for chapter one.',
      'More text.',
      '# Chapter Two',
      'Body of chapter two.',
    ].join('\n');
    const chapters = splitChapters(md);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('Chapter One');
    expect(chapters[0].body).toContain('# Chapter One');
    expect(chapters[0].body).toContain('Intro text for chapter one.');
    expect(chapters[0].body).not.toContain('Chapter Two');
    expect(chapters[1].title).toBe('Chapter Two');
    expect(chapters[1].body).toContain('Body of chapter two.');
  });

  it('falls back to H2 when there are fewer than two H1s', () => {
    const md = [
      '# Book Title',
      '## Chapter One',
      'First chapter content.',
      '## Chapter Two',
      'Second chapter content.',
    ].join('\n');
    const chapters = splitChapters(md);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('Chapter One');
    expect(chapters[1].title).toBe('Chapter Two');
    expect(chapters[1].body).toContain('Second chapter content.');
  });

  it('falls back to a single chapter when there are fewer than two H1s AND fewer than two H2s', () => {
    const md = '# Only Heading\nJust one chapter worth of content, no other headings.';
    const chapters = splitChapters(md);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('Only Heading');
    expect(chapters[0].body).toContain('Just one chapter worth of content');
  });

  it('falls back to a single chapter with a default title when there are no headings at all', () => {
    const md = 'Plain content with no markdown headings whatsoever.';
    const chapters = splitChapters(md);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBeTruthy();
    expect(chapters[0].body).toBe(md);
  });
});
