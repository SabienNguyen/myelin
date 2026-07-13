import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// src/server -> repo root
const REPO_ROOT = join(here, '..', '..');
const MARKER_BIN = join(REPO_ROOT, '.tools', 'marker-venv', 'bin', 'marker_single');
const PANDOC_BIN = join(REPO_ROOT, '.tools', 'pandoc', 'pandoc');

export type Converter = (file: string, outDir: string) => Promise<{ markdown: string }>;

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

/** marker_single nests its output in <outDir>/<file-stem-without-ext>/<file-stem>.md. */
async function convertPdf(file: string, outDir: string): Promise<{ markdown: string }> {
  if (!existsSync(MARKER_BIN)) {
    throw new Error(
      `marker binary not found at ${MARKER_BIN} — the marker-venv install may still be downloading; `
      + 'run its setup before converting PDFs.',
    );
  }
  await run(MARKER_BIN, [file, '--output_format', 'markdown', '--output_dir', outDir]);
  const stem = basename(file, extname(file));
  const nested = join(outDir, stem);
  const files = await readdir(nested);
  const mdFile = files.find((f) => f.endsWith('.md'));
  if (!mdFile) throw new Error(`marker produced no .md file in ${nested}`);
  const markdown = await readFile(join(nested, mdFile), 'utf8');
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
