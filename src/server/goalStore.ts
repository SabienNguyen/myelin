// The learner's active goal — "what am I trying to learn right now".
//
// Why this exists: Engram already has the syllabus primitive (curated paths, written by
// create_path, read by list_paths/read_path) and the graph payload has carried a `goal: null` field
// since it was written, never populated. So the system could answer "what should I learn next"
// against the whole vault, but never "how far through THIS subject am I" — which is the question a
// learner starting a new subject actually has.
//
// Territory: this is harness state, not vault knowledge, so it lives under vault/.harness/ alongside
// the compile queue and the notify ledger. Engram remains the only writer of pages/ and
// students/. The goal deliberately stores only a POINTER (a path slug or a page slug) — never a copy
// of the syllabus itself, which would immediately drift from the path doc it was copied from.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Goal {
  /** 'path' -> a curated path slug (the normal case); 'page' -> a single target page slug. */
  kind: 'path' | 'page';
  slug: string;
  /** ISO yyyy-mm-dd, for "you set this N days ago" and nothing else. */
  setOn: string;
}

// Same CHARACTER-CLASS allowlist as sessionStore's THREAD_ID and ingestRepo's REPO_NAME_RE (the
// security-relevant part: this value is interpolated into MCP tool arguments and compared against
// vault slugs, so `[a-z0-9-]` only, starting alphanumeric, is validated at the boundary rather than
// trusted). The LENGTH bound is looser than those two on purpose: a thread-id and a repo-name become
// a directory/file NAME the harness itself mints and can keep short, but a goal slug POINTS AT a
// page/path slug, which is title-derived by slugify (no length cap) and only bounded by the
// filesystem filename limit. Capping the pointer at 64 rejected a perfectly real long-titled page —
// "Introduction to the Fundamental Theorem of Calculus…" slugifies to 83 chars — so write_page
// created it but the goal route 400'd on "invalid goal slug". 250 keeps `<slug>.md` inside the
// 255-byte filename limit while accepting any realistic title.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,249}$/;

const goalPath = (vault: string) => join(vault, '.harness', 'goal.json');

/** Reads the active goal, or null when none is set or the file is unreadable/malformed. Never
 *  throws: a corrupt goal must not take down the whole bootstrap, and "no goal" is a valid state. */
export function readGoal(vault: string): Goal | null {
  // Guard the vault path itself, not just the file contents. /api/graph now reads the goal, and that
  // payload previously needed no vault at all — a caller holding a partial config (several route
  // tests build `{ student }` only) would otherwise crash join() and turn the whole graph endpoint
  // into a 500. "No goal" is the right answer for "nowhere to look", consistent with this function's
  // never-throws contract.
  if (typeof vault !== 'string' || vault === '') return null;
  const p = goalPath(vault);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (raw?.kind !== 'path' && raw?.kind !== 'page') return null;
    if (typeof raw.slug !== 'string' || !SLUG_RE.test(raw.slug)) return null;
    return { kind: raw.kind, slug: raw.slug, setOn: typeof raw.setOn === 'string' ? raw.setOn : '' };
  } catch {
    return null;
  }
}

/** Sets (or with null, clears) the active goal. Returns what was stored so the caller can echo it. */
export function writeGoal(vault: string, goal: Omit<Goal, 'setOn'> | null, now = new Date()): Goal | null {
  mkdirSync(join(vault, '.harness'), { recursive: true });
  if (goal === null) {
    writeFileSync(goalPath(vault), JSON.stringify(null));
    return null;
  }
  if (!SLUG_RE.test(goal.slug)) throw new Error(`invalid goal slug: ${goal.slug}`);
  const stored: Goal = { kind: goal.kind, slug: goal.slug, setOn: now.toISOString().slice(0, 10) };
  writeFileSync(goalPath(vault), JSON.stringify(stored, null, 2));
  return stored;
}

export interface PathProgress {
  slug: string;
  title: string;
  pages: string[];
  /** Pages whose EFFECTIVE level is practicing or mastered — decay-aware on purpose, so a path does
   *  not keep claiming credit for something the learner has since lost. */
  known: number;
  total: number;
  /** First page in teaching order that is not yet known — where to resume. null when complete. */
  nextSlug: string | null;
}

const KNOWN = new Set(['practicing', 'mastered']);

/** Folds a path's ordered page list against the student's decay-adjusted state. Pure so it can be
 *  tested without a vault or an MCP server. `state` is get_student_state's map shape:
 *  slug -> { effective, ... }. Pages absent from the map are simply unseen. */
export function pathProgress(
  path: { slug: string; title: string; pages: string[] },
  state: Record<string, { effective?: string } | undefined>,
): PathProgress {
  const known = path.pages.filter((p) => KNOWN.has(state[p]?.effective ?? 'unseen')).length;
  const nextSlug = path.pages.find((p) => !KNOWN.has(state[p]?.effective ?? 'unseen')) ?? null;
  return { slug: path.slug, title: path.title, pages: path.pages, known, total: path.pages.length, nextSlug };
}
