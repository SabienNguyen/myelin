// The course bank: problem sets and past exams as QUESTION BANKS, not prose.
//
// "Add book" compiles material into readable pages — right for a textbook, wrong for a past
// exam. A student the week before a test does not want the exam paraphrased into notes; they
// want to be drilled on the professor's actual problems, in the professor's notation. This
// module extracts numbered problems from a converted document and stores them per-source, so
// the tutor can quiz from the real artifact instead of inventing lookalikes.
//
// Extraction is mechanical (numbering patterns), not model-driven: a bank whose problems were
// paraphrased by a model would quietly lose the alignment that is its whole reason to exist.

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CourseProblem {
  /** Stable id: <source-slug>#<n>. */
  id: string;
  /** The source document this came from (slugified filename). */
  source: string;
  /** Problem number as printed (1-based ordinal of extraction when unnumbered forms repeat). */
  n: number;
  /** The problem statement, verbatim from the converted markdown. */
  text: string;
  /** Inline solution when the document carried one (Answer:/Solution: block). */
  answer?: string;
  /** ISO date the bank entry was created. */
  added: string;
  /** Set when the learner has been drilled on it and got it right (spacing decides re-asks). */
  lastCorrect?: string;
}

const bankPath = (vault: string) => join(vault, '.harness', 'course-bank.jsonl');

/**
 * Lines that begin a new problem. Ordered: the specific word forms first, bare numbering last.
 * Matches the printed forms real course documents use — "Problem 3", "Q4.", "Question 5:",
 * "Exercise 2.1", "3.", "3)", "(3)".
 */
const PROBLEM_STARTS: RegExp[] = [
  /^\s{0,3}(?:\*\*)?(?:Problem|Question|Exercise|Q)\s*(\d+(?:\.\d+)?)(?:\*\*)?\s*[.:)]?\s*/i,
  /^\s{0,3}\(?(\d{1,2})[.)]\s+/,
];

/** Lines that begin an inline solution within a problem's span. */
const ANSWER_START = /^\s{0,3}(?:\*\*)?(?:Answer|Solution|Ans)(?:\*\*)?\s*[.:]\s*/i;

/** Headings and furniture that end a problem without starting a new one. */
const HARD_BREAK = /^\s{0,3}#{1,6}\s|^\s*---+\s*$/;

function startMatch(line: string): { n: number; rest: string } | null {
  for (const re of PROBLEM_STARTS) {
    const m = line.match(re);
    if (m) return { n: Number.parseFloat(m[1]), rest: line.slice(m[0].length) };
  }
  return null;
}

/**
 * Extract numbered problems from converted markdown.
 *
 * Deliberately conservative: a document yielding fewer than MIN_PROBLEMS is judged not to be a
 * problem set (a textbook chapter with one numbered list would otherwise become a bogus bank),
 * and extraction returns [] so callers fall back to the normal reading path.
 */
export function extractProblems(md: string): { n: number; text: string; answer?: string }[] {
  const MIN_PROBLEMS = 3;
  const lines = md.split('\n');
  const out: { n: number; text: string; answer?: string }[] = [];
  let current: { n: number; body: string[]; answer: string[] | null } | null = null;

  const flush = () => {
    if (!current) return;
    const text = current.body.join('\n').trim();
    if (text) {
      out.push({
        n: current.n,
        text,
        ...(current.answer && current.answer.join('\n').trim()
          ? { answer: current.answer.join('\n').trim() } : {}),
      });
    }
    current = null;
  };

  for (const line of lines) {
    const start = startMatch(line);
    if (start) {
      flush();
      current = { n: start.n, body: [start.rest], answer: null };
      continue;
    }
    if (!current) continue;
    if (HARD_BREAK.test(line)) { flush(); continue; }
    if (ANSWER_START.test(line)) {
      current.answer = [line.replace(ANSWER_START, '')];
      continue;
    }
    (current.answer ?? current.body).push(line);
  }
  flush();

  return out.length >= MIN_PROBLEMS ? out : [];
}

/** All bank entries, newest source last. Corrupt lines are skipped, not fatal — the bank is an
 *  accumulating log and one bad line must not take down the whole feature. */
export function readBank(vault: string): CourseProblem[] {
  const p = bankPath(vault);
  if (!existsSync(p)) return [];
  const out: CourseProblem[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as CourseProblem); } catch { /* skip bad line */ }
  }
  return out;
}

/** Append a source's extracted problems. Idempotent per source: re-ingesting the same document
 *  replaces its entries rather than duplicating them (a student re-adds the same pset constantly). */
export function saveProblems(
  vault: string, source: string, problems: { n: number; text: string; answer?: string }[],
): CourseProblem[] {
  mkdirSync(join(vault, '.harness'), { recursive: true });
  const added = new Date().toISOString().slice(0, 10);
  const fresh: CourseProblem[] = problems.map((p) => ({
    id: `${source}#${p.n}`, source, n: p.n, text: p.text,
    ...(p.answer ? { answer: p.answer } : {}), added,
  }));
  const others = readBank(vault).filter((e) => e.source !== source);
  const all = [...others, ...fresh];
  writeFileSync(bankPath(vault), all.map((e) => JSON.stringify(e)).join('\n') + (all.length ? '\n' : ''));
  return fresh;
}

/** Mark a problem correctly answered today — spacing reads this to decide re-asks. */
export function markCorrect(vault: string, id: string): boolean {
  const all = readBank(vault);
  const hit = all.find((e) => e.id === id);
  if (!hit) return false;
  hit.lastCorrect = new Date().toISOString().slice(0, 10);
  writeFileSync(bankPath(vault), all.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return true;
}

/**
 * The next problems worth drilling: never-answered first (in source order), then correct-longest-ago.
 * The tutor asks these VERBATIM — the alignment contract of the whole feature.
 */
export function nextProblems(vault: string, k = 5): CourseProblem[] {
  const all = readBank(vault);
  const fresh = all.filter((e) => !e.lastCorrect);
  const answered = all.filter((e) => e.lastCorrect)
    .sort((a, b) => (a.lastCorrect ?? '').localeCompare(b.lastCorrect ?? ''));
  return [...fresh, ...answered].slice(0, k);
}
