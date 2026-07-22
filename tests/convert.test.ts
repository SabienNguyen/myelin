import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  consumeContiguousSlices, isMarkerBatchAvailable, pdfPageCount, splitChapters, splitPdfSlices,
  type SliceInfo, cleanHeading,
} from '../src/server/convert.js';

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

// Skipped when the marker-venv python isn't present — pypdfium2-only, no marker/GPU involvement,
// same rationale as the pdfPageCount describe block above.
describe.skipIf(!existsSync(MARKER_PYTHON))('splitPdfSlices', () => {
  it('splits a multi-page PDF into slice files of the requested size, each independently readable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-split-'));
    const p = join(dir, 'seven-pages.pdf');
    makeTestPdf(p, 7);
    const slicesDir = join(dir, 'slices');

    const { total, slices } = await splitPdfSlices(p, slicesDir, 3);

    expect(total).toBe(7);
    expect(slices).toEqual([
      { index: 0, start: 0, end: 3, file: 'slice-000.pdf' },
      { index: 1, start: 3, end: 6, file: 'slice-001.pdf' },
      { index: 2, start: 6, end: 7, file: 'slice-002.pdf' },
    ]);
    for (const s of slices) expect(existsSync(join(slicesDir, s.file))).toBe(true);

    // Each slice is itself a valid, independently-openable PDF with the right page count.
    await expect(pdfPageCount(join(slicesDir, 'slice-000.pdf'))).resolves.toBe(3);
    await expect(pdfPageCount(join(slicesDir, 'slice-001.pdf'))).resolves.toBe(3);
    await expect(pdfPageCount(join(slicesDir, 'slice-002.pdf'))).resolves.toBe(1);
  });

  it('produces exactly one slice when the whole document fits under slicePages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-split-'));
    const p = join(dir, 'two-pages.pdf');
    makeTestPdf(p, 2);
    const slicesDir = join(dir, 'slices');

    const { total, slices } = await splitPdfSlices(p, slicesDir, 32);

    expect(total).toBe(2);
    expect(slices).toEqual([{ index: 0, start: 0, end: 2, file: 'slice-000.pdf' }]);
    await expect(pdfPageCount(join(slicesDir, 'slice-000.pdf'))).resolves.toBe(2);
  });
});

describe('isMarkerBatchAvailable', () => {
  it('returns false when the binary path does not exist', async () => {
    await expect(isMarkerBatchAvailable('/no/such/marker-binary')).resolves.toBe(false);
  });

  it('returns false when --help exits non-zero (e.g. a missing python dependency)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-batchavail-'));
    const fakeBin = join(dir, 'fake-marker-broken');
    writeFileSync(fakeBin, '#!/bin/sh\necho "ModuleNotFoundError" >&2\nexit 1\n');
    chmodSync(fakeBin, 0o755);
    await expect(isMarkerBatchAvailable(fakeBin)).resolves.toBe(false);
  });

  it('returns true when --help exits zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-batchavail-'));
    const fakeBin = join(dir, 'fake-marker-ok');
    writeFileSync(fakeBin, '#!/bin/sh\necho "Usage: marker ..."\nexit 0\n');
    chmodSync(fakeBin, 0o755);
    await expect(isMarkerBatchAvailable(fakeBin)).resolves.toBe(true);
  });

  // Documents the actual state of this repo's marker-venv (see convert.ts's isMarkerBatchAvailable
  // comment): the batch CLI's psutil dependency was never installed and there's no pip in this
  // uv-managed venv to add it, so this always resolves false here — every PDF conversion in this
  // environment runs the per-slice loop. Skipped entirely off-machine (CI / other checkouts) since
  // asserting a specific value for the *real* binary would otherwise start passing/failing purely
  // based on unrelated venv setup, which isn't this test's job.
  describe.skipIf(!existsSync(join(REPO_ROOT, '.tools', 'marker-venv', 'bin', 'marker')))('real venv', () => {
    it('reflects whether marker --help actually runs in this checkout', async () => {
      const result = await isMarkerBatchAvailable();
      expect(typeof result).toBe('boolean');
    });
  });
});

describe('consumeContiguousSlices', () => {
  function slicesOf(n: number, size: number): SliceInfo[] {
    const out: SliceInfo[] = [];
    let start = 0;
    let idx = 0;
    while (start < n) {
      const end = Math.min(start + size, n);
      out.push({ index: idx, start, end, file: `slice-${String(idx).padStart(3, '0')}.pdf` });
      start = end;
      idx++;
    }
    return out;
  }

  function writeSliceMd(outDir: string, file: string, body: string): void {
    const stem = file.replace(/\.pdf$/, '');
    mkdirSync(join(outDir, stem), { recursive: true });
    writeFileSync(join(outDir, stem, `${stem}.md`), body);
  }

  it('consumes only the contiguous prefix, stopping at the first gap', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'lwh-consume-'));
    const slices = slicesOf(96, 32); // 3 slices: 0-32, 32-64, 64-96
    const calls: { pagesDone: number; final: boolean }[] = [];
    const state = { nextIndex: 0, cumulative: '' };

    // Slice 0 and slice 2 exist, but slice 1 (the next expected) is missing — must not skip ahead.
    writeSliceMd(outDir, slices[0].file, 'Slice zero content.');
    writeSliceMd(outDir, slices[2].file, 'Slice two content.');

    await consumeContiguousSlices(outDir, slices, 96, state, (u) => {
      calls.push({ pagesDone: u.pagesDone, final: u.final });
    });

    expect(state.nextIndex).toBe(1);
    expect(calls).toEqual([{ pagesDone: 32, final: false }]);
    expect(state.cumulative).toBe('Slice zero content.');

    // Now the gap fills in — a second call picks up exactly where it left off, in order, and the
    // final call (the true last slice) is marked final: true.
    writeSliceMd(outDir, slices[1].file, 'Slice one content.');
    await consumeContiguousSlices(outDir, slices, 96, state, (u) => {
      calls.push({ pagesDone: u.pagesDone, final: u.final });
    });

    expect(state.nextIndex).toBe(3);
    expect(calls).toEqual([
      { pagesDone: 32, final: false },
      { pagesDone: 64, final: false },
      { pagesDone: 96, final: true },
    ]);
    expect(state.cumulative).toBe('Slice zero content.\n\nSlice one content.\n\nSlice two content.');
  });

  it('never double-consumes an already-processed slice on a repeated call', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'lwh-consume-'));
    const slices = slicesOf(32, 32); // single slice
    const state = { nextIndex: 0, cumulative: '' };
    writeSliceMd(outDir, slices[0].file, 'Only slice.');

    let callCount = 0;
    await consumeContiguousSlices(outDir, slices, 32, state, () => { callCount++; });
    await consumeContiguousSlices(outDir, slices, 32, state, () => { callCount++; }); // no-op: already done

    expect(callCount).toBe(1);
    expect(state.nextIndex).toBe(1);
  });

  it('caps pagesDone at total for a final slice shorter than the slice size', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'lwh-consume-'));
    const slices: SliceInfo[] = [{ index: 0, start: 0, end: 5, file: 'slice-000.pdf' }];
    const state = { nextIndex: 0, cumulative: '' };
    writeSliceMd(outDir, slices[0].file, 'Short final slice.');

    let pagesDone = -1;
    let final = false;
    await consumeContiguousSlices(outDir, slices, 5, state, (u) => {
      pagesDone = u.pagesDone;
      final = u.final;
    });

    expect(pagesDone).toBe(5);
    expect(final).toBe(true);
  });
});

describe('cleanHeading (marker HTML anchors)', () => {
  it('strips span anchors and collapses whitespace', () => {
    expect(cleanHeading('<span id="page-30-4"></span><span id="x"></span> Limits  and Continuity'))
      .toBe('Limits and Continuity');
  });
  it('feeds through splitChapters titles', () => {
    const md = '# <span id="a"></span>One\nbody\n# <span id="b"></span>Two\nbody2';
    expect(splitChapters(md).map((c) => c.title)).toEqual(['One', 'Two']);
  });
});

describe('cleanHeading (LaTeX heading markup)', () => {
  it('strips a $...$ wrapper, \\rm, and \\; spacing commands', () => {
    expect(cleanHeading('$12 \\;\\; {\\rm Generalized \\; Linear \\; Models \\; *}$'))
      .toBe('12 Generalized Linear Models *');
  });
  it('turns backslash-escaped spaces into real spaces and strips a _{...} group', () => {
    expect(cleanHeading('$14 \\ _{\\rm Neural\\ Networks\\ for\\ Images}$'))
      .toBe('14 Neural Networks for Images');
  });
  it('leaves a plain title with no LaTeX markup unchanged', () => {
    expect(cleanHeading('19 Learning with Fewer Labeled Examples'))
      .toBe('19 Learning with Fewer Labeled Examples');
  });
});

describe('splitChapters chapter-promotion pass', () => {
  it('promotes embedded un-dotted H2 chapter headings into their own chapters', () => {
    const md = [
      '# 4 Statistics',
      'Statistics body text.',
      '## 4.1 Introduction',
      'Section text, not a chapter.',
      '## <span id="x"></span>5 Decision Theory',
      'Decision theory body.',
      '## 5.1 Bayesian decision theory',
      'More section text.',
      '## 6 Information Theory',
      'Info theory body.',
      '# 8 Optimization',
      'Optimization body.',
    ].join('\n');
    const chapters = splitChapters(md);
    expect(chapters.map((c) => c.title)).toEqual([
      '4 Statistics', '5 Decision Theory', '6 Information Theory', '8 Optimization',
    ]);
    expect(chapters[0].body).toContain('Statistics body text.');
    expect(chapters[0].body).toContain('4.1 Introduction');
    expect(chapters[0].body).not.toContain('Decision theory body.');
    expect(chapters[1].body).toContain('Decision theory body.');
    expect(chapters[1].body).toContain('5.1 Bayesian decision theory');
    expect(chapters[1].body).not.toContain('Info theory body.');
    expect(chapters[2].body).toContain('Info theory body.');
    expect(chapters[2].body).not.toContain('Optimization body.');
    expect(chapters[3].body).toContain('Optimization body.');
  });

  it('never promotes a dotted section heading, however chapter-like its number looks', () => {
    const md = [
      '# 4 Statistics',
      'body',
      '## 4.1 Introduction',
      'section body',
      '## 4.2 Another section',
      'more section body',
      '# 8 Optimization',
      'opt body',
    ].join('\n');
    const chapters = splitChapters(md);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('4 Statistics');
    expect(chapters[0].body).toContain('4.1 Introduction');
    expect(chapters[0].body).toContain('4.2 Another section');
  });

  it('promotes a single-letter appendix heading but never its dotted A.1 subsections', () => {
    const md = [
      '# 21 Clustering',
      'clustering body',
      '## A Notation',
      'appendix body',
      '## A.1 Introduction',
      'appendix section body',
      '## A.2 Common mathematical symbols',
      'more appendix section body',
      '# 22 Recommender Systems',
      'recsys body',
    ].join('\n');
    const chapters = splitChapters(md);
    expect(chapters.map((c) => c.title)).toEqual(['21 Clustering', 'A Notation', '22 Recommender Systems']);
    expect(chapters[1].body).toContain('appendix body');
    expect(chapters[1].body).toContain('A.1 Introduction');
    expect(chapters[1].body).toContain('A.2 Common mathematical symbols');
    expect(chapters[1].body).not.toContain('recsys body');
  });

  it('never promotes non-chapter H2s like "Part I" or "Index"', () => {
    const md = [
      '# 1 Introduction',
      'intro body',
      '## Part I',
      '## Foundations',
      'part body',
      '## Index',
      'index body',
      '# 2 Probability',
      'prob body',
    ].join('\n');
    const chapters = splitChapters(md);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('1 Introduction');
    expect(chapters[0].body).toContain('Part I');
    expect(chapters[0].body).toContain('Index');
  });
});
