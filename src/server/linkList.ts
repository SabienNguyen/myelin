// Link-directory ("awesome list") detection and extraction. Some of the most-shared learning
// resources on GitHub are not books or code at all — they are curated DIRECTORIES of external
// links (awesome-scalability and kin: one huge README whose sections are bulleted lists of
// blog/paper/talk URLs with one-line blurbs). Fed through the ordinary docs pass, such a file
// compiles into pages that are just themed tables of contents: the actual knowledge lives one hop
// away behind URLs the compiler never follows, the mining pass finds no code, and — because
// nothing mechanical can ever grade a list of links — every one of those pages is capped below
// 'mastered' forever. Worst input shape for the pipeline, and it was our most likely paste.
//
// So: detect the shape, and EXPLODE it instead of compiling it. The extracted links become a
// browsable catalogue in the Library, where each entry is one click from the existing
// single-document ingest (POST /api/ingest {url}) — the pipeline's BEST case: a video URL becomes
// a transcript paper, an article/PDF becomes a real compiled page. Deliberately not auto-ingested:
// a directory this size (awesome-scalability carries several hundred links) would mean hours of
// conversion the learner never asked for; the catalogue makes choosing the work, and the choice
// stays theirs.
//
// Detection is a heuristic over the doc's own line structure — no model call, no network. The
// thresholds are conservative on purpose: a false positive here HIDES a readable document from
// the compile pipeline, which is worse than a false negative (a link list compiled into mediocre
// pages still shows its links as links).

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { maskFences } from './convert.js';

export interface DirectoryLink {
  title: string;
  url: string;
  note?: string; // the bullet's own blurb, after the link — kept because it is the curator's one
  // line of judgment, exactly what the learner needs to decide whether to ingest.
}
export interface DirectorySection { title: string; links: DirectoryLink[] }

export interface LinkListAnalysis {
  isLinkList: boolean;
  sections: DirectorySection[];
  total: number; // links kept across all sections
  omitted: number; // links dropped past MAX_LINKS — surfaced, never a silent cap
}

/** A stored catalogue: one per exploded repo, under vault/.harness/linklists/<name>.json. */
export interface LinkDirectoryFile {
  name: string; // repo-derived name, doubles as the filename stem
  source: string; // what was pasted (git URL / local path) — provenance for the UI
  file: string; // repo-relative doc path the links came from (or comma-joined when several)
  savedAt: string; // ISO timestamp
  sections: DirectorySection[];
  total: number;
  omitted: number;
}

// ── heuristics ──────────────────────────────────────────────────────────────────────────────

/** Minimum external-link bullets before a doc can be a directory at all. A normal README's
 *  "References" section stays safely under this; awesome-lists clear it by an order of
 *  magnitude. */
const MIN_LINKS = 15;
/** Link bullets must be at least this share of the doc's content lines (all bullets + prose
 *  paragraphs). A prose-heavy README that happens to cite twenty links reads as a document; a
 *  directory is MOSTLY links by construction. */
const MIN_LINK_SHARE = 0.5;
/** Hard cap on catalogued links — awesome-lists run to four figures, and past this the catalogue
 *  stops being a browsing aid. The overflow is COUNTED (analysis.omitted), never silent. */
const MAX_LINKS = 800;
const MAX_NOTE_LEN = 200;

const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const HEADING_RE = /^(#{1,4})\s+(.+)$/;
// First markdown link on a bullet: [title](http://... "optional title")
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/;
// Badges and images are decoration, not resources — a shields.io badge inside a link bullet must
// not become the "resource" we catalogue.
const IMAGE_OR_BADGE_RE = /(shields\.io|badge|\.svg|\.png|\.gif|\.jpe?g)([?#].*)?$/i;

function stripMarkdown(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // nested links -> their text
    .replace(/[*_`]/g, '')
    .trim();
}

/** The blurb after the first link: separators stripped, inner markdown flattened, length-capped. */
function extractNote(afterLink: string): string | undefined {
  const cleaned = stripMarkdown(afterLink.replace(/^\s*[-–—:.]\s*/, ''));
  if (!cleaned) return undefined;
  return cleaned.length > MAX_NOTE_LEN ? `${cleaned.slice(0, MAX_NOTE_LEN - 1)}…` : cleaned;
}

/**
 * Classify a markdown document as link-directory-or-not and extract its links grouped by the
 * nearest heading. Pure — string in, analysis out. Fenced code blocks are masked first so a
 * URL inside an example never counts as a catalogued resource (same discipline splitChapters
 * applies to headings).
 */
export function analyzeLinkList(markdown: string): LinkListAnalysis {
  const lines = maskFences(markdown).split('\n');

  let linkBullets = 0;
  let otherBullets = 0;
  let proseLines = 0;

  const sections: DirectorySection[] = [];
  const seenUrls = new Set<string>();
  let current: DirectorySection | null = null;
  let total = 0;
  let omitted = 0;

  const sectionFor = (title: string): DirectorySection => {
    const t = stripMarkdown(title) || 'Links';
    const existing = sections.find((s) => s.title === t);
    if (existing) return existing;
    const fresh = { title: t, links: [] };
    sections.push(fresh);
    return fresh;
  };

  for (const line of lines) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      current = sectionFor(heading[2]);
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      const m = MD_LINK_RE.exec(bullet[1]);
      if (m && !IMAGE_OR_BADGE_RE.test(m[2])) {
        linkBullets++;
        const url = m[2];
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          if (total < MAX_LINKS) {
            const title = stripMarkdown(m[1]) || url;
            const note = extractNote(bullet[1].slice(m.index + m[0].length));
            (current ?? sectionFor('Links')).links.push({ title, url, ...(note ? { note } : {}) });
            total++;
          } else {
            omitted++;
          }
        }
      } else {
        otherBullets++;
      }
      continue;
    }
    const trimmed = line.trim();
    // Prose = paragraph text. Skip blanks, block quotes, tables, rules, html/badge rows — they are
    // layout, and counting them as prose would let a badge-heavy directory dodge the share test.
    if (trimmed && !/^[>|]|^---+$|^<|^!\[/.test(trimmed)) proseLines++;
  }

  const contentLines = linkBullets + otherBullets + proseLines;
  const isLinkList = linkBullets >= MIN_LINKS && linkBullets / Math.max(1, contentLines) >= MIN_LINK_SHARE;

  return {
    isLinkList,
    sections: isLinkList ? sections.filter((s) => s.links.length > 0) : [],
    total: isLinkList ? total : 0,
    omitted: isLinkList ? omitted : 0,
  };
}

// ── storage ─────────────────────────────────────────────────────────────────────────────────

const dirFor = (vault: string) => join(vault, '.harness', 'linklists');

export function saveLinkDirectory(vault: string, entry: LinkDirectoryFile): void {
  mkdirSync(dirFor(vault), { recursive: true });
  writeFileSync(join(dirFor(vault), `${entry.name}.json`), JSON.stringify(entry, null, 2));
}

export function readLinkDirectories(vault: string): LinkDirectoryFile[] {
  const dir = dirFor(vault);
  if (!existsSync(dir)) return [];
  const out: LinkDirectoryFile[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LinkDirectoryFile;
      if (parsed && Array.isArray(parsed.sections)) out.push(parsed);
    } catch {
      // A truncated write (crash mid-save) must not take the whole listing down with it.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteLinkDirectory(vault: string, name: string): boolean {
  // The name doubles as a filename stem — same traversal caution as every other client-named
  // path in this codebase (deriveRepoName's allowlist produced it, but the DELETE route takes it
  // back from the client, so re-check).
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return false;
  const file = join(dirFor(vault), `${name}.json`);
  if (!existsSync(file)) return false;
  try {
    rmSync(file);
    return true;
  } catch {
    return false;
  }
}
