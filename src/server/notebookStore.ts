// Notebooks — the learner's own grouping of conversations and sources around one subject.
//
// Harness state, not vault knowledge: a notebook is a folder label over things that already exist
// (thread files under .harness/sessions, source records in .harness/sources.json), so it lives in
// .harness/notebooks.json and Engram never hears of it. It stores POINTERS only. Its topics, their
// mastery and what is due are never copied in; they are derived on every read from the pages its
// conversations touched and its sources compiled into (summarizeNotebook), because a stored copy
// would start drifting from the student ledger the moment the next piece of evidence landed.
//
// Every mutation here is a synchronous read-modify-write with no await between the read and the
// atomicWrite, so two requests in the same process cannot interleave and lose an update — the
// failure queueStore.ts's updateQueue exists to prevent for a writer that DOES await mid-update.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './atomicWrite.js';
import { assertThreadId } from './sessionStore.js';
import type { SourceRecord } from './provenance.js';

export interface Notebook {
  id: string;
  title: string;
  createdAt: string; // ISO
  /** Thread ids, oldest first. A thread belongs to at most one notebook. */
  threads: string[];
  /** SourceRecord.book keys. */
  sources: string[];
}

// Same allowlist as a thread id (sessionStore's THREAD_ID): the id travels in URLs and API paths,
// never into a file name, but one rule for every harness-minted id is easier to reason about than
// two. It also screens the thread ids read back from disk — a hand-edited entry that fails it would
// otherwise reach loadThread, which throws, and take the whole notebook list down with it.
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TITLE_MAX = 80;

const notebooksPath = (vault: string) => join(vault, '.harness', 'notebooks.json');

/** Every notebook, oldest first. A torn or hand-edited file degrades to "no notebooks" rather than
 *  throwing: the list is read on every chat turn's bootstrap, and an unreadable label file must
 *  cost the grouping, never the conversation. Entries missing their required fields are dropped
 *  for the same reason. */
export function readNotebooks(vault: string): Notebook[] {
  if (!vault) return [];
  const p = notebooksPath(vault);
  if (!existsSync(p)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('[notebooks] unreadable notebooks.json, treating as empty:', e instanceof Error ? e.message : e);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((n: any): n is Notebook =>
    typeof n?.id === 'string' && ID.test(n.id) && typeof n.title === 'string'
    && Array.isArray(n.threads) && Array.isArray(n.sources))
    .map((n) => ({
      id: n.id,
      title: n.title,
      createdAt: typeof n.createdAt === 'string' ? n.createdAt : '',
      threads: n.threads.filter((t): t is string => typeof t === 'string' && ID.test(t)),
      sources: n.sources.filter((s): s is string => typeof s === 'string'),
    }));
}

function write(vault: string, notebooks: Notebook[]): void {
  atomicWrite(notebooksPath(vault), JSON.stringify(notebooks, null, 2));
}

function cleanTitle(title: unknown): string {
  const t = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  if (!t) throw new Error('a notebook needs a title');
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) : t;
}

export function getNotebook(vault: string, id: string): Notebook | undefined {
  return readNotebooks(vault).find((n) => n.id === id);
}

/** The notebook a thread belongs to, if any. */
export function notebookForThread(vault: string, threadId: string): Notebook | undefined {
  return readNotebooks(vault).find((n) => n.threads.includes(threadId));
}

export function createNotebook(vault: string, title: unknown, now = new Date()): Notebook {
  const notebooks = readNotebooks(vault);
  // Base-36 time plus a short random tail: two notebooks created in the same millisecond (a
  // double-clicked button) must not collide on id.
  const id = `nb-${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const nb: Notebook = { id, title: cleanTitle(title), createdAt: now.toISOString(), threads: [], sources: [] };
  write(vault, [...notebooks, nb]);
  return nb;
}

function update(vault: string, id: string, fn: (nb: Notebook) => Notebook): Notebook {
  const notebooks = readNotebooks(vault);
  const i = notebooks.findIndex((n) => n.id === id);
  if (i === -1) throw new NotebookNotFound(id);
  notebooks[i] = fn(notebooks[i]);
  write(vault, notebooks);
  return notebooks[i];
}

export class NotebookNotFound extends Error {
  constructor(id: string) {
    super(`no notebook "${id}"`);
    this.name = 'NotebookNotFound';
  }
}

export function renameNotebook(vault: string, id: string, title: unknown): Notebook {
  const t = cleanTitle(title);
  return update(vault, id, (nb) => ({ ...nb, title: t }));
}

/** Replaces the notebook's source list. Unknown books are refused rather than stored: a pointer
 *  to a source that does not exist would show as a source nobody can open. */
export function setNotebookSources(vault: string, id: string, books: unknown, known: SourceRecord[]): Notebook {
  if (!Array.isArray(books) || books.some((b) => typeof b !== 'string')) {
    throw new Error('sources must be a list of source names');
  }
  const knownBooks = new Set(known.map((s) => s.book));
  const unknown = books.filter((b) => !knownBooks.has(b));
  if (unknown.length) throw new Error(`no such source: ${unknown.join(', ')}`);
  return update(vault, id, (nb) => ({ ...nb, sources: [...new Set(books as string[])] }));
}

/** Files a thread under a notebook. A thread lives in one notebook at most, so it leaves any other
 *  first; filing it where it already is changes nothing. */
export function attachThread(vault: string, id: string, threadId: string): Notebook {
  assertThreadId(threadId);
  const notebooks = readNotebooks(vault);
  if (!notebooks.some((n) => n.id === id)) throw new NotebookNotFound(id);
  const next = notebooks.map((n) => {
    const others = n.threads.filter((t) => t !== threadId);
    return n.id === id ? { ...n, threads: [...others, threadId] } : { ...n, threads: others };
  });
  write(vault, next);
  return next.find((n) => n.id === id)!;
}

/** Removes the grouping only. Its conversations and sources stay where they always were, and show
 *  up again under history and the Library. */
export function deleteNotebook(vault: string, id: string): void {
  const notebooks = readNotebooks(vault);
  if (!notebooks.some((n) => n.id === id)) throw new NotebookNotFound(id);
  write(vault, notebooks.filter((n) => n.id !== id));
}

/** What a thread deletion leaves behind: its id in whichever notebook held it. */
export function forgetThread(vault: string, threadId: string): void {
  const notebooks = readNotebooks(vault);
  if (!notebooks.some((n) => n.threads.includes(threadId))) return;
  write(vault, notebooks.map((n) => ({ ...n, threads: n.threads.filter((t) => t !== threadId) })));
}

// ── derived view ───────────────────────────────────────────────────────────────────────────────

export type Level = 'mastered' | 'practicing' | 'exposed' | 'unseen';

export interface StudentEntry { effective?: string; days_left?: number | null; slipped?: boolean }

export interface NotebookSummary {
  id: string;
  title: string;
  createdAt: string;
  /** Attached sources that still exist. */
  sources: number;
  /** Member conversations with at least one message. */
  chats: number;
  /** Distinct pages the notebook covers. */
  topics: number;
  /** Topic count per EFFECTIVE (decay-adjusted) level, so the bar moves down when mastery decays. */
  mastery: Record<Level, number>;
  /** Topics already slipped or within DUE_SOON_DAYS of slipping — the same rule as /api/due. */
  due: number;
  /** Latest activity: the newest member conversation's save time, else the creation time. */
  lastActive: string;
}

export const DUE_SOON_DAYS = 5;

/** The /api/due rule, shared so a notebook's "3 due" and the review queue never disagree. */
export function isDue(m: StudentEntry | undefined): boolean {
  if (!m) return false;
  return m.slipped === true || (typeof m.days_left === 'number' && m.days_left <= DUE_SOON_DAYS);
}

export function levelOf(m: StudentEntry | undefined): Level {
  const e = m?.effective;
  return e === 'mastered' || e === 'practicing' || e === 'exposed' ? e : 'unseen';
}

/**
 * A notebook's topics: pages its conversations worked on (record_evidence / write_page /
 * read_page, via the caller's pagesTouched) and pages its sources compiled into, first-seen order,
 * limited to pages that exist. The existence filter matters: a write_page that failed still leaves
 * a tool part naming its slug, and a page that was never written is not something the learner
 * covered.
 */
export function notebookTopics(
  nb: Notebook,
  touched: (threadId: string) => string[],
  sources: SourceRecord[],
  exists: (slug: string) => boolean,
): string[] {
  const out = new Set<string>();
  for (const t of nb.threads) for (const slug of touched(t)) out.add(slug);
  for (const s of sources) {
    if (!nb.sources.includes(s.book)) continue;
    for (const ch of s.spine ?? []) for (const slug of ch.pages) out.add(slug);
  }
  return [...out].filter(exists);
}

/** Pure: everything a notebook card shows, from the pointers plus the facts it points at. */
export function summarizeNotebook(
  nb: Notebook,
  a: {
    topics: string[];
    threads: { id: string; updatedAt: string; messages: number }[];
    sources: SourceRecord[];
    state: Record<string, StudentEntry | undefined>;
  },
): NotebookSummary {
  const mastery: Record<Level, number> = { mastered: 0, practicing: 0, exposed: 0, unseen: 0 };
  let due = 0;
  for (const slug of a.topics) {
    mastery[levelOf(a.state[slug])] += 1;
    if (isDue(a.state[slug])) due += 1;
  }
  const members = a.threads.filter((t) => nb.threads.includes(t.id) && t.messages > 0);
  const lastActive = members.reduce((latest, t) => (t.updatedAt > latest ? t.updatedAt : latest), nb.createdAt);
  return {
    id: nb.id,
    title: nb.title,
    createdAt: nb.createdAt,
    sources: a.sources.filter((s) => nb.sources.includes(s.book)).length,
    chats: members.length,
    topics: a.topics.length,
    mastery,
    due,
    lastActive,
  };
}
