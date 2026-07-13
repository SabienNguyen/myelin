import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfPageCount, splitChapters } from '../src/server/convert.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..');
const MARKER_PYTHON = join(REPO_ROOT, '.tools', 'marker-venv', 'bin', 'python');

/** Hand-rolled minimal multi-page PDF — no dependencies, no marker/GPU involvement. Just enough
 * xref/trailer structure for pypdfium2 (marker's PDF backend) to read /Count off the page tree. */
function makeTestPdf(path: string, pages: number): void {
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>');

  let out = '%PDF-1.4\n';
  const offsets: number[] = [0];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefOffset = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets.slice(1)) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  writeFileSync(path, out);
}

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

// Skipped when the marker-venv python isn't present on this machine (CI / other environments) —
// pdfPageCount already degrades to null in that case, which is exercised by the "no such file"
// case below regardless.
describe.skipIf(!existsSync(MARKER_PYTHON))('pdfPageCount', () => {
  it('counts pages via the marker venv python (pypdfium2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-pdfcount-'));
    const p = join(dir, 'five-pages.pdf');
    makeTestPdf(p, 5);
    await expect(pdfPageCount(p)).resolves.toBe(5);
  });

  it('counts a different page count correctly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-pdfcount-'));
    const p = join(dir, 'one-page.pdf');
    makeTestPdf(p, 1);
    await expect(pdfPageCount(p)).resolves.toBe(1);
  });
});

describe('pdfPageCount failure modes', () => {
  it('returns null for a nonexistent file', async () => {
    await expect(pdfPageCount('/no/such/file.pdf')).resolves.toBeNull();
  });

  it('returns null for a file that is not a valid PDF', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-pdfcount-'));
    const p = join(dir, 'not-a-pdf.pdf');
    writeFileSync(p, 'this is not a pdf');
    await expect(pdfPageCount(p)).resolves.toBeNull();
  });
});
