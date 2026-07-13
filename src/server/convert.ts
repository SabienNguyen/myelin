import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// src/server -> repo root
const REPO_ROOT = join(here, '..', '..');
const MARKER_BIN = join(REPO_ROOT, '.tools', 'marker-venv', 'bin', 'marker_single');
const MARKER_PYTHON = join(REPO_ROOT, '.tools', 'marker-venv', 'bin', 'python');
const PANDOC_BIN = join(REPO_ROOT, '.tools', 'pandoc', 'pandoc');

export type Converter = (file: string, outDir: string) => Promise<{ markdown: string }>;

/** Incremental variant: converts a document slice-by-slice (PDFs with a known page count run in
 * 32-page slices; everything else runs single-shot). Calls onProgress after each slice with the
 * CUMULATIVE markdown assembled so far — never just the slice's own delta. `final` marks the
 * last call. `pagesTotal` is null when the page count couldn't be determined (EPUB/DOCX, or a
 * PDF pdfPageCount() failed on) — those formats convert in exactly one onProgress call. */
export type IncrementalConverter = (
  file: string,
  outDir: string,
  onProgress: (u: {
    markdown: string; pagesDone: number; pagesTotal: number | null; final: boolean;
  }) => void | Promise<void>,
) => Promise<void>;

function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

/**
 * Page count for a PDF — used to decide whether incremental conversion is possible and to plan
 * its 32-page slices.
 *
 * NOTE (deviation from the original plan): this marker-venv install does not actually ship
 * `pypdf` — verified via `pip list` / site-packages listing, only `pypdfium2` (marker's own PDF
 * backend) is present. `len(pdfium.PdfDocument(path))` gives the identical page count, so that's
 * what this uses instead. Verified against a hand-built 5-page PDF.
 *
 * Returns null on ANY failure (missing venv, corrupt PDF, python error) so callers fall back to
 * single-shot conversion rather than fail the whole ingest.
 */
export async function pdfPageCount(file: string): Promise<number | null> {
  if (!existsSync(MARKER_PYTHON)) return null;
  try {
    const out = await runCapture(MARKER_PYTHON, [
      '-c', 'import pypdfium2 as pdfium, sys; print(len(pdfium.PdfDocument(sys.argv[1])))', file,
    ]);
    const n = Number.parseInt(out.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** marker and ollama share one consumer GPU — a resident 7B chat model plus marker's ~6.5GB of
 * layout/OCR models is a guaranteed CUDA OOM (observed live: 880MB short on an 8GB card). Ask
 * ollama to unload everything before converting; models reload lazily on the next chat turn.
 * Best-effort: if ollama is down or the API changed, conversion proceeds anyway. */
async function freeOllamaVram(): Promise<void> {
  const base = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/v1\/?$/, '');
  try {
    const ps = await (await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) })).json() as
      { models?: { name: string }[] };
    for (const m of ps.models ?? []) {
      await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: m.name, keep_alive: 0 }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
  } catch { /* ollama absent — nothing to unload */ }
}

/**
 * Runs marker on one file (optionally restricted to a page range via extraArgs) into its own
 * outDir, GPU-first with a CPU retry on failure, and returns the resulting markdown. Factored out
 * of convertPdf so the incremental converter can reuse the exact same GPU-coordination/CPU-
 * fallback logic per-slice. marker_single nests its output in
 * <outDir>/<file-stem-without-ext>/<file-stem>.md regardless of --page_range.
 */
async function runMarkerSlice(file: string, outDir: string, extraArgs: string[] = []): Promise<string> {
  if (!existsSync(MARKER_BIN)) {
    throw new Error(
      `marker binary not found at ${MARKER_BIN} — the marker-venv install may still be downloading; `
      + 'run its setup before converting PDFs.',
    );
  }
  await freeOllamaVram();
  // --disable_image_extraction on every run: the harness never uses images, and skipping
  // extraction is a big speedup on scanned books.
  const markerArgs = [
    file, '--output_format', 'markdown', '--output_dir', outDir, '--disable_image_extraction', ...extraArgs,
  ];
  try {
    await run(MARKER_BIN, markerArgs, { PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True' });
  } catch (e) {
    // Big scanned books can exceed the card even alone — finish on CPU rather than fail.
    console.error(`[convert] marker GPU run failed (${e instanceof Error ? e.message : e}); retrying on CPU`);
    await run(MARKER_BIN, markerArgs, { TORCH_DEVICE: 'cpu' });
  }
  const stem = basename(file, extname(file));
  const nested = join(outDir, stem);
  const files = await readdir(nested);
  const mdFile = files.find((f) => f.endsWith('.md'));
  if (!mdFile) throw new Error(`marker produced no .md file in ${nested}`);
  return readFile(join(nested, mdFile), 'utf8');
}

async function convertPdf(file: string, outDir: string): Promise<{ markdown: string }> {
  const markdown = await runMarkerSlice(file, outDir);
  return { markdown };
}

async function convertWithPandoc(file: string, outDir: string): Promise<{ markdown: string }> {
  if (!existsSync(PANDOC_BIN)) {
    throw new Error(
      `pandoc binary not found at ${PANDOC_BIN} — download the linux-amd64 static tarball from `
      + 'GitHub releases into .tools/pandoc/ before converting EPUB/DOCX.',
    );
  }
  const out = join(outDir, `${basename(file, extname(file))}.md`);
  await run(PANDOC_BIN, [file, '-t', 'gfm', '--wrap=none', '-o', out]);
  const markdown = await readFile(out, 'utf8');
  return { markdown };
}

/** Dispatches on file extension. Tests never invoke this — they inject a fake Converter instead. */
export const defaultConverter: Converter = async (file, outDir) => {
  const ext = extname(file).toLowerCase();
  if (ext === '.pdf') return convertPdf(file, outDir);
  if (ext === '.epub' || ext === '.docx') return convertWithPandoc(file, outDir);
  throw new Error(`unsupported file type for conversion: "${ext}" (expected .pdf, .epub, or .docx)`);
};

/** Pages per marker slice for incremental PDF conversion — large enough to amortize marker's
 * fixed per-run model-load cost, small enough that a slow book streams chapters every few
 * minutes rather than only at the very end. */
const SLICE_PAGES = 32;

/**
 * Incremental dispatch: a PDF whose page count is known converts in SLICE_PAGES-page slices,
 * calling onProgress after each with the cumulative markdown assembled so far (marker's
 * --page_range is 0-indexed and inclusive on both ends per `marker_single --help`, e.g.
 * "0-31" for the first 32 pages). Everything else (PDF with unknown page count, EPUB, DOCX)
 * converts single-shot via the existing paths, calling onProgress exactly once with final=true
 * and pagesTotal=null. Tests never invoke this — they inject a fake IncrementalConverter.
 */
export const defaultIncrementalConverter: IncrementalConverter = async (file, outDir, onProgress) => {
  const ext = extname(file).toLowerCase();

  if (ext === '.pdf') {
    const total = await pdfPageCount(file);
    if (total != null) {
      let cumulative = '';
      let start = 0;
      while (start < total) {
        const end = Math.min(start + SLICE_PAGES - 1, total - 1); // inclusive, 0-indexed
        const sliceDir = join(outDir, `slice-${start}-${end}`);
        const sliceMarkdown = await runMarkerSlice(file, sliceDir, ['--page_range', `${start}-${end}`]);
        cumulative = cumulative ? `${cumulative}\n\n${sliceMarkdown}` : sliceMarkdown;
        const pagesDone = end + 1;
        await onProgress({ markdown: cumulative, pagesDone, pagesTotal: total, final: pagesDone >= total });
        start = end + 1;
      }
      return;
    }
  }

  const { markdown } = await defaultConverter(file, outDir);
  await onProgress({ markdown, pagesDone: 0, pagesTotal: null, final: true });
};

const H1 = /^#\s+(.+)$/gm;
const H2 = /^##\s+(.+)$/gm;

/**
 * Splits a combined markdown document into per-chapter { title, body } pairs, one per H1
 * heading. Falls back to H2 headings when there are fewer than two H1s (some converters flatten
 * the book title into the only H1), and falls back to a single chapter covering the whole
 * document when neither level yields at least two headings. Pure — no I/O.
 */
export function splitChapters(markdown: string): { title: string; body: string }[] {
  let matches = [...markdown.matchAll(H1)];
  if (matches.length < 2) matches = [...markdown.matchAll(H2)];
  if (matches.length < 2) {
    const first = [...markdown.matchAll(/^#{1,2}\s+(.+)$/gm)][0];
    return [{ title: first?.[1]?.trim() ?? 'Chapter 1', body: markdown.trim() }];
  }
  return matches.map((m, i) => {
    const start = m.index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : markdown.length;
    return { title: m[1].trim(), body: markdown.slice(start, end).trim() };
  });
}
