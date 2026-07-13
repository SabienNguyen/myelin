import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// src/server -> repo root
const REPO_ROOT = join(here, '..', '..');
const MARKER_BIN = join(REPO_ROOT, '.tools', 'marker-venv', 'bin', 'marker_single');
const MARKER_BATCH_BIN = join(REPO_ROOT, '.tools', 'marker-venv', 'bin', 'marker');
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

type OnIncrementalProgress = (u: {
  markdown: string; pagesDone: number; pagesTotal: number | null; final: boolean;
}) => void | Promise<void>;

/**
 * The per-slice --page_range loop: one marker_single invocation per SLICE_PAGES-page range,
 * reloading marker's ~6.5GB of models every time (30-60s × ~total/32 slices on a big book). This
 * is the original (and only, pre-T34) incremental-conversion strategy — still the tested CPU-
 * fallback path (via runMarkerSlice's own per-slice GPU->CPU retry) and the fallback target when
 * the batch binary is unavailable or fails before it commits any progress (see
 * defaultIncrementalConverter). marker's --page_range is 0-indexed and inclusive on both ends per
 * `marker_single --help`, e.g. "0-31" for the first 32 pages.
 */
async function runPerSliceIncremental(
  file: string, outDir: string, total: number, onProgress: OnIncrementalProgress,
): Promise<void> {
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
}

export interface SliceInfo { index: number; start: number; end: number; file: string }

let batchAvailableCache: boolean | null = null;

/**
 * Whether the batch `marker` binary can actually run here — checked via a `marker --help`
 * invocation (CPU-only, no model load; a plain `existsSync` isn't enough because a broken venv
 * still has the launcher script on disk). Cached per-process for the default binary path only, so
 * production pays this once; tests pass an explicit path to bypass the cache.
 *
 * NOTE (deviation, verified live): in THIS repo's marker-venv, `marker --help` fails with
 * `ModuleNotFoundError: No module named 'psutil'` — the batch CLI's dependency (marker/scripts/
 * convert.py imports psutil directly) was never installed, and this venv has no `pip`/`pip3`
 * binary to fix it (it's a `uv`-managed venv — see `.tools/marker-venv/pyvenv.cfg`). marker_single
 * itself doesn't import psutil and works fine. So on this machine, this always returns false and
 * every PDF conversion runs the per-slice loop below — that's a pre-existing environment gap, not
 * a bug in this function; fixing it (installing psutil into the shared venv) was intentionally
 * left undone here because a real 860-page conversion was using that exact venv's marker_single
 * process on the GPU while this task was implemented.
 */
export async function isMarkerBatchAvailable(binPath: string = MARKER_BATCH_BIN): Promise<boolean> {
  const useCache = binPath === MARKER_BATCH_BIN;
  if (useCache && batchAvailableCache != null) return batchAvailableCache;
  let available: boolean;
  if (!existsSync(binPath)) {
    available = false;
  } else {
    try {
      await runCapture(binPath, ['--help']);
      available = true;
    } catch {
      available = false;
    }
  }
  if (useCache) batchAvailableCache = available;
  return available;
}

/** Inline python (run via the marker-venv python, one invocation) that splits a source PDF into
 * `slicePages`-page slice FILES using pypdfium2 — verified against the installed version via
 * `.tools/marker-venv/bin/python -c "import pypdfium2; help(pypdfium2.PdfDocument.import_pages)"`:
 * `PdfDocument.new()` makes an empty destination doc, `dst.import_pages(src, pages=[...])` copies
 * zero-based page indices in, `dst.save(path)` writes it out. Prints a single JSON line
 * `{ total, slices: [{ index, start, end, file }] }` (start/end are the same half-open
 * [start, end) convention used elsewhere in this module) so the caller never has to re-derive
 * slice boundaries from the filesystem. */
const SPLIT_PDF_SCRIPT = `
import sys, os, json
import pypdfium2 as pdfium

src_path, out_dir, slice_pages = sys.argv[1], sys.argv[2], int(sys.argv[3])
os.makedirs(out_dir, exist_ok=True)
src = pdfium.PdfDocument(src_path)
total = len(src)
slices = []
start = 0
idx = 0
while start < total:
    end = min(start + slice_pages, total)
    dst = pdfium.PdfDocument.new()
    dst.import_pages(src, pages=list(range(start, end)))
    name = f"slice-{idx:03d}.pdf"
    dst.save(os.path.join(out_dir, name))
    slices.append({"index": idx, "start": start, "end": end, "file": name})
    start = end
    idx += 1
print(json.dumps({"total": total, "slices": slices}))
`;

/** Pre-splits `file` into slice PDFs (see SPLIT_PDF_SCRIPT) under `slicesInDir`. Exported and unit
 * tested directly against a synthetic multi-page PDF — pypdfium2-only, no marker/GPU involved, so
 * safe to actually run (same class of operation as pdfPageCount). Throws on any failure (missing
 * venv python, corrupt PDF); callers treat that as a preflight failure and fall back. */
export async function splitPdfSlices(
  file: string, slicesInDir: string, slicePages: number,
): Promise<{ total: number; slices: SliceInfo[] }> {
  if (!existsSync(MARKER_PYTHON)) throw new Error(`marker-venv python not found at ${MARKER_PYTHON}`);
  mkdirSync(slicesInDir, { recursive: true });
  const scriptPath = join(slicesInDir, '..', 'split-pdf-slices.py');
  writeFileSync(scriptPath, SPLIT_PDF_SCRIPT);
  const out = await runCapture(MARKER_PYTHON, [scriptPath, file, slicesInDir, String(slicePages)]);
  return JSON.parse(out.trim()) as { total: number; slices: SliceInfo[] };
}

/**
 * Reads the CONTIGUOUS prefix of slice outputs available in `outDir` (marker's batch mode writes
 * <outDir>/<slice-stem>/<slice-stem>.md per slice as it finishes — NOT necessarily in input order,
 * even at --workers 1: marker's own `convert_cli` builds its file list via unsorted `os.listdir()`
 * over the input folder). Consumes forward from `state.nextIndex`, stopping at the first slice
 * whose .md isn't there yet, so slices always fold into the cumulative markdown in order and never
 * twice — `final` is true exactly on the call that consumes the very last slice, however many
 * batches of polling that takes. Mutates `state` in place. Exported standalone specifically so
 * this ordering/no-double-consume contract is unit testable without ever spawning marker.
 */
export async function consumeContiguousSlices(
  outDir: string, slices: SliceInfo[], total: number,
  state: { nextIndex: number; cumulative: string },
  onProgress: OnIncrementalProgress,
): Promise<void> {
  while (state.nextIndex < slices.length) {
    const slice = slices[state.nextIndex];
    const stem = basename(slice.file, extname(slice.file));
    const mdPath = join(outDir, stem, `${stem}.md`);
    if (!existsSync(mdPath)) return;
    const sliceMarkdown = await readFile(mdPath, 'utf8');
    state.cumulative = state.cumulative ? `${state.cumulative}\n\n${sliceMarkdown}` : sliceMarkdown;
    state.nextIndex++;
    const pagesDone = Math.min(slice.end, total);
    const final = state.nextIndex === slices.length;
    await onProgress({ markdown: state.cumulative, pagesDone, pagesTotal: total, final });
  }
}

const BATCH_POLL_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Runs the batch `marker` binary once over `slicesInDir` -> `slicesOutDir`, polling every
 * BATCH_POLL_MS while it runs (plus one final catch-up read after it exits) and folding newly-
 * completed contiguous slices into onProgress via consumeContiguousSlices. --workers stays 1 (one
 * GPU) and --skip_existing lets a CPU retry after a partial GPU failure skip slices that already
 * finished. Throws if the process fails to spawn or exits non-zero — the GPU->CPU retry lives one
 * level up in runBatchIncremental, mirroring runMarkerSlice's own per-slice retry but applied once
 * to the whole batch.
 */
async function runBatchAttempt(
  slicesInDir: string, slicesOutDir: string, env: Record<string, string>,
  slices: SliceInfo[], total: number, state: { nextIndex: number; cumulative: string },
  onProgress: OnIncrementalProgress,
): Promise<void> {
  const child = spawn(MARKER_BATCH_BIN, [
    slicesInDir, '--output_dir', slicesOutDir, '--output_format', 'markdown',
    '--disable_image_extraction', '--workers', '1', '--skip_existing',
  ], { stdio: 'inherit', env: { ...process.env, ...env } });

  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
  let finished = false;
  exited.then(() => { finished = true; }, () => { finished = true; });

  while (!finished) {
    await consumeContiguousSlices(slicesOutDir, slices, total, state, onProgress);
    if (finished) break;
    await sleep(BATCH_POLL_MS);
  }
  const code = await exited; // rethrows the child's 'error' event (e.g. ENOENT) if spawning failed
  await consumeContiguousSlices(slicesOutDir, slices, total, state, onProgress); // final catch-up
  if (code !== 0) throw new Error(`marker batch exited with code ${code}`);
}

/**
 * Batch path for a PDF with a known page count: pre-splits it into SLICE_PAGES-page slice FILES
 * (splitPdfSlices) and runs the batch `marker` binary ONCE over the whole folder — one model load
 * for the entire book instead of one marker_single invocation (and model load) per slice.
 *
 * `state` is passed in (not just returned) so the caller can inspect state.nextIndex after a
 * thrown error to decide whether it's safe to fall back to the per-slice loop — see
 * defaultIncrementalConverter's comment for why that matters.
 */
async function runBatchIncremental(
  file: string, outDir: string, total: number, onProgress: OnIncrementalProgress,
  state: { nextIndex: number; cumulative: string },
): Promise<void> {
  const slicesInDir = join(outDir, 'slices-in');
  const slicesOutDir = join(outDir, 'slices-out');
  const { slices } = await splitPdfSlices(file, slicesInDir, SLICE_PAGES);

  await freeOllamaVram();

  let gpuErr: unknown;
  try {
    await runBatchAttempt(
      slicesInDir, slicesOutDir, { PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True' },
      slices, total, state, onProgress,
    );
  } catch (e) {
    gpuErr = e;
  }

  if (gpuErr) {
    console.error(
      `[convert] marker batch GPU run failed (${gpuErr instanceof Error ? gpuErr.message : gpuErr}); `
      + 'retrying the whole batch on CPU',
    );
    await runBatchAttempt(slicesInDir, slicesOutDir, { TORCH_DEVICE: 'cpu' }, slices, total, state, onProgress);
  }

  if (state.nextIndex < slices.length) {
    throw new Error(
      `marker batch run finished but only produced ${state.nextIndex}/${slices.length} slice outputs`,
    );
  }
}

/**
 * Incremental dispatch for a PDF whose page count is known: tries the single-model-load batch path
 * first (isMarkerBatchAvailable preflight + splitPdfSlices), falling back to the per-slice
 * --page_range loop when either preflight step fails OR the batch run itself fails *before it has
 * committed any progress* (state.nextIndex === 0 — no onProgress call has fired yet, so nothing in
 * the ledger depends on the batch run's partial output). Once even one slice has been folded into
 * onProgress, a batch failure propagates as a genuine conversion error instead of falling back —
 * restarting via the per-slice loop at that point would re-derive the same chapters from scratch
 * and risk duplicating/conflicting with whatever the batch run already queued.
 *
 * Everything else (PDF with unknown page count, EPUB, DOCX) converts single-shot via the existing
 * paths, calling onProgress exactly once with final=true and pagesTotal=null.
 *
 * Tests never invoke this directly — they inject a fake IncrementalConverter (same policy as the
 * pre-T34 code: exercising this for real would mean actually running marker/GPU, which the test
 * suite deliberately never does). Its extracted pieces (splitPdfSlices, consumeContiguousSlices,
 * isMarkerBatchAvailable) are unit tested individually instead.
 */
export const defaultIncrementalConverter: IncrementalConverter = async (file, outDir, onProgress) => {
  const ext = extname(file).toLowerCase();

  if (ext === '.pdf') {
    const total = await pdfPageCount(file);
    if (total != null) {
      if (await isMarkerBatchAvailable()) {
        const state = { nextIndex: 0, cumulative: '' };
        try {
          await runBatchIncremental(file, outDir, total, onProgress, state);
          return;
        } catch (e) {
          if (state.nextIndex > 0) throw e; // partial progress already landed — don't restart
          console.error(
            `[convert] batch conversion unavailable before any progress landed `
            + `(${e instanceof Error ? e.message : e}); falling back to the per-slice loop`,
          );
        }
      }
      await runPerSliceIncremental(file, outDir, total, onProgress);
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
