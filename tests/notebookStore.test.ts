import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachThread, createNotebook, deleteNotebook, forgetThread, getNotebook, isDue,
  notebookForThread, notebookTopics, readNotebooks, renameNotebook, setNotebookSources,
  summarizeNotebook, NotebookNotFound, type Notebook,
} from '../src/server/notebookStore.js';
import { pagesTouched, threadTopic } from '../src/server/session.js';
import type { SourceRecord } from '../src/server/provenance.js';

let vault: string;
beforeEach(() => { vault = mkdtempSync(join(tmpdir(), 'notebooks-')); });

const source = (book: string, pages: string[] = []): SourceRecord => ({
  book, title: book.toUpperCase(), authors: [], attribution: 'unknown',
  origin: { kind: 'file' }, addedAt: '2026-09-01T00:00:00Z',
  spine: pages.length ? [{ chapter: `${book}/ch1`, chapterOrdinal: 1, title: 'ch1', pages }] : undefined,
});

describe('notebookStore — the grouping itself', () => {
  it('creates, persists and renames a notebook', () => {
    const nb = createNotebook(vault, '  Calculus   I ', new Date('2026-09-23T10:00:00Z'));
    expect(nb.title).toBe('Calculus I');
    expect(nb.createdAt).toBe('2026-09-23T10:00:00.000Z');
    expect(readNotebooks(vault)).toEqual([nb]);
    expect(renameNotebook(vault, nb.id, 'Calculus 1').title).toBe('Calculus 1');
    expect(getNotebook(vault, nb.id)?.title).toBe('Calculus 1');
  });

  it('refuses an empty title', () => {
    expect(() => createNotebook(vault, '   ')).toThrow(/needs a title/);
    expect(() => createNotebook(vault, 42)).toThrow(/needs a title/);
    expect(readNotebooks(vault)).toEqual([]);
  });

  it('gives two notebooks created in the same millisecond different ids', () => {
    const now = new Date('2026-09-23T10:00:00Z');
    const a = createNotebook(vault, 'A', now);
    const b = createNotebook(vault, 'B', now);
    expect(a.id).not.toBe(b.id);
    expect(readNotebooks(vault)).toHaveLength(2);
  });

  it('files a thread under exactly one notebook, moving it when filed again', () => {
    const a = createNotebook(vault, 'A');
    const b = createNotebook(vault, 'B');
    attachThread(vault, a.id, 't-1');
    attachThread(vault, a.id, 't-1'); // idempotent
    expect(getNotebook(vault, a.id)?.threads).toEqual(['t-1']);
    attachThread(vault, b.id, 't-1');
    expect(getNotebook(vault, a.id)?.threads).toEqual([]);
    expect(notebookForThread(vault, 't-1')?.id).toBe(b.id);
  });

  it('refuses a thread id that could escape the sessions directory', () => {
    const a = createNotebook(vault, 'A');
    expect(() => attachThread(vault, a.id, '../../etc')).toThrow(/invalid threadId/);
  });

  it('names the missing notebook instead of creating one', () => {
    expect(() => attachThread(vault, 'nb-nope', 't-1')).toThrow(NotebookNotFound);
    expect(() => renameNotebook(vault, 'nb-nope', 'x')).toThrow(NotebookNotFound);
    expect(() => deleteNotebook(vault, 'nb-nope')).toThrow(NotebookNotFound);
    expect(readNotebooks(vault)).toEqual([]);
  });

  it('only points at sources that exist', () => {
    const a = createNotebook(vault, 'A');
    const known = [source('spivak'), source('notes')];
    expect(setNotebookSources(vault, a.id, ['spivak', 'spivak'], known).sources).toEqual(['spivak']);
    expect(() => setNotebookSources(vault, a.id, ['ghost'], known)).toThrow(/no such source: ghost/);
    expect(() => setNotebookSources(vault, a.id, 'spivak', known)).toThrow(/list of source names/);
    expect(setNotebookSources(vault, a.id, ['spivak', 'notes'], known).sources).toEqual(['spivak', 'notes']);
  });

  it('deleting a notebook keeps its threads out of it and nothing else', () => {
    const a = createNotebook(vault, 'A');
    const b = createNotebook(vault, 'B');
    attachThread(vault, a.id, 't-1');
    deleteNotebook(vault, a.id);
    expect(readNotebooks(vault).map((n) => n.id)).toEqual([b.id]);
    expect(notebookForThread(vault, 't-1')).toBeUndefined();
  });

  it('forgets a deleted thread and leaves the file alone when no notebook held it', () => {
    const a = createNotebook(vault, 'A');
    attachThread(vault, a.id, 't-1');
    forgetThread(vault, 't-1');
    expect(getNotebook(vault, a.id)?.threads).toEqual([]);
    const before = readFileSync(join(vault, '.harness', 'notebooks.json'), 'utf8');
    forgetThread(vault, 't-2');
    expect(readFileSync(join(vault, '.harness', 'notebooks.json'), 'utf8')).toBe(before);
  });

  it('reads a corrupt or malformed file as no notebooks, dropping only the bad entries', () => {
    mkdirSync(join(vault, '.harness'), { recursive: true });
    const p = join(vault, '.harness', 'notebooks.json');
    writeFileSync(p, '{ torn');
    expect(readNotebooks(vault)).toEqual([]);
    writeFileSync(p, JSON.stringify([
      { id: 'nb-ok', title: 'ok', createdAt: 'x', threads: ['t', 3, '../escape'], sources: [] },
      { id: '../bad', title: 'bad', threads: [], sources: [] },
      { id: 'nb-notitle', threads: [], sources: [] },
    ]));
    expect(readNotebooks(vault)).toEqual([{ id: 'nb-ok', title: 'ok', createdAt: 'x', threads: ['t'], sources: [] }]);
  });
});

describe('notebook topics and summary — derived, never stored', () => {
  const nb: Notebook = { id: 'nb-1', title: 'Calc', createdAt: '2026-09-01T00:00:00Z', threads: ['t-1', 't-2'], sources: ['spivak'] };

  it('unions conversation pages and source pages, and drops pages that were never written', () => {
    const touched: Record<string, string[]> = { 't-1': ['limits', 'ghost-page'], 't-2': ['derivative', 'limits'] };
    const topics = notebookTopics(nb, (t) => touched[t] ?? [], [source('spivak', ['continuity']), source('other', ['sets'])],
      (s) => s !== 'ghost-page');
    expect(topics).toEqual(['limits', 'derivative', 'continuity']);
  });

  it('counts mastery by effective level and due by the review-queue rule', () => {
    const s = summarizeNotebook(nb, {
      topics: ['limits', 'derivative', 'continuity', 'chain-rule'],
      threads: [
        { id: 't-1', updatedAt: '2026-09-20T00:00:00Z', messages: 4 },
        { id: 't-2', updatedAt: '2026-09-22T00:00:00Z', messages: 0 }, // empty: not a chat, not activity
        { id: 't-9', updatedAt: '2026-09-23T00:00:00Z', messages: 2 }, // someone else's
      ],
      sources: [source('spivak'), source('other')],
      state: {
        limits: { effective: 'mastered', days_left: 3 },
        derivative: { effective: 'practicing', slipped: true },
        continuity: { effective: 'exposed', days_left: null },
      },
    });
    expect(s.mastery).toEqual({ mastered: 1, practicing: 1, exposed: 1, unseen: 1 });
    expect(s.due).toBe(2);
    expect(s.chats).toBe(1);
    expect(s.sources).toBe(1);
    expect(s.topics).toBe(4);
    expect(s.lastActive).toBe('2026-09-20T00:00:00Z');
  });

  it('isDue matches /api/due: slipped, or five days or fewer left', () => {
    expect(isDue({ slipped: true })).toBe(true);
    expect(isDue({ days_left: 5 })).toBe(true);
    expect(isDue({ days_left: 6 })).toBe(false);
    expect(isDue({ days_left: null })).toBe(false);
    expect(isDue(undefined)).toBe(false);
  });
});

describe('pagesTouched', () => {
  const tool = (name: string, slug: unknown) => ({ type: `tool-${name}`, toolCallId: `c-${name}-${String(slug)}`, state: 'output-available', input: { slug }, output: {} });
  it('lists every page a thread worked on once, in first-seen order, and ignores other tools', () => {
    const messages = [
      { id: 'm1', role: 'assistant', parts: [tool('read_page', 'limits'), tool('search', 'limits'), tool('write_page', 'derivative')] },
      { id: 'm2', role: 'assistant', parts: [tool('record_evidence', 'limits'), tool('read_page', 42)] },
    ] as any;
    expect(pagesTouched(messages)).toEqual(['limits', 'derivative']);
    // threadTopic still means "the last one touched".
    expect(threadTopic(messages)).toBe('limits');
    expect(pagesTouched([])).toEqual([]);
  });
});
