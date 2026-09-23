import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { buildNotebookRoutes } from '../src/server/notebookRoutes.js';
import { buildChatRoute } from '../src/server/chatRoute.js';
import { saveThread } from '../src/server/sessionStore.js';
import { recordSource } from '../src/server/provenance.js';
import { readNotebooks } from '../src/server/notebookStore.js';
import type { HarnessConfig } from '../src/server/config.js';

let vault: string;
let app: Hono;

const PAGES: Record<string, string> = { limits: 'Limits', derivative: 'Derivative', continuity: 'Continuity' };
const STATE = {
  limits: { effective: 'mastered', days_left: 30 },
  derivative: { effective: 'practicing', slipped: true },
};

const lw = {
  listSlugs: async () => Object.keys(PAGES),
  call: async (name: string) => {
    if (name === 'get_student_state') return STATE;
    if (name === 'list_pages') return { pages: Object.entries(PAGES).map(([slug, title]) => ({ slug, title })) };
    throw new Error(`unexpected call ${name}`);
  },
} as any;

const toolPart = (name: string, slug: string) =>
  ({ type: `tool-${name}`, toolCallId: `c-${slug}`, state: 'output-available', input: { slug }, output: {} });

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'nb-routes-'));
  const cfg = { vault, student: 'kid' } as HarnessConfig;
  app = new Hono();
  app.route('/', buildNotebookRoutes(lw, cfg));
  app.route('/', buildChatRoute(lw, cfg));
});

const json = (method: string, body?: unknown) => ({
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

async function create(title: string) {
  const res = await app.request('/api/notebooks', json('POST', { title }));
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string }>;
}

describe('notebook routes', () => {
  it('builds a notebook from its conversations and sources, and says what is due', async () => {
    const { id } = await create('Calculus I');
    saveThread(vault, 't-1', [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'what is a derivative, really?' }] },
      { id: 'a1', role: 'assistant', parts: [toolPart('read_page', 'derivative'), toolPart('write_page', 'never-written')] },
    ]);
    saveThread(vault, 't-loose', [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'something unrelated' }] }]);
    recordSource(vault, {
      book: 'spivak', title: 'Spivak, Calculus', authors: ['Michael Spivak'], attribution: 'verified',
      origin: { kind: 'file' }, addedAt: '2026-09-01T00:00:00Z',
      spine: [{ chapter: 'spivak/ch5', chapterOrdinal: 5, title: 'Limits', pages: ['limits'] }],
    });

    expect((await app.request(`/api/notebooks/${id}/threads/t-1`, { method: 'PUT' })).status).toBe(200);
    expect((await app.request(`/api/notebooks/${id}`, json('PATCH', { sources: ['spivak'] }))).status).toBe(200);

    const list = await (await app.request('/api/notebooks')).json();
    expect(list.notebooks).toHaveLength(1);
    expect(list.notebooks[0]).toMatchObject({
      title: 'Calculus I', chats: 1, sources: 1, topics: 2, due: 1,
      mastery: { mastered: 1, practicing: 1, exposed: 0, unseen: 0 },
    });
    // The loose conversation stays reachable from the home screen; the filed one does not repeat.
    expect(list.unfiled.map((t: any) => t.id)).toEqual(['t-loose']);

    const detail = await (await app.request(`/api/notebooks/${id}`)).json();
    expect(detail.topics).toEqual([
      { slug: 'derivative', title: 'Derivative', level: 'practicing', due: true, daysLeft: null },
      { slug: 'limits', title: 'Limits', level: 'mastered', due: false, daysLeft: 30 },
    ]);
    expect(detail.threads.map((t: any) => t.id)).toEqual(['t-1']);
    expect(detail.sources).toEqual([{ book: 'spivak', title: 'Spivak, Calculus', authors: ['Michael Spivak'] }]);
    expect(detail.library.map((s: any) => s.book)).toEqual(['spivak']);

    const threads = await (await app.request('/api/threads')).json();
    expect(threads.find((t: any) => t.id === 't-1').notebook).toEqual({ id, title: 'Calculus I' });
    expect(threads.find((t: any) => t.id === 't-loose').notebook).toBeNull();

    // The page's own view of the same membership: from a conversation, and from a source.
    expect(await (await app.request('/api/page/derivative/notebooks')).json()).toEqual([{ id, title: 'Calculus I' }]);
    expect(await (await app.request('/api/page/limits/notebooks')).json()).toEqual([{ id, title: 'Calculus I' }]);
    expect(await (await app.request('/api/page/continuity/notebooks')).json()).toEqual([]);

    const of = await (await app.request('/api/thread/t-1/notebook')).json();
    expect(of).toEqual({ id, title: 'Calculus I' });
    expect(await (await app.request('/api/thread/t-loose/notebook')).json()).toBeNull();
  });

  it('starts a notebook from a loose source in one request, and a bad source creates nothing', async () => {
    recordSource(vault, { book: 'clayden', title: 'Clayden, Organic Chemistry', authors: ['Jonathan Clayden'], attribution: 'verified', origin: { kind: 'file' }, addedAt: '' });
    const before = await (await app.request('/api/notebooks')).json();
    expect(before.looseSources).toEqual([{ book: 'clayden', title: 'Clayden, Organic Chemistry', authors: ['Jonathan Clayden'] }]);

    const bad = await app.request('/api/notebooks', json('POST', { title: 'X', sources: ['ghost'] }));
    expect(bad.status).toBe(400);
    expect(readNotebooks(vault)).toEqual([]);

    const res = await app.request('/api/notebooks', json('POST', { title: 'Clayden, Organic Chemistry', sources: ['clayden'] }));
    expect(res.status).toBe(201);
    expect((await res.json()).sources).toEqual(['clayden']);
    const after = await (await app.request('/api/notebooks')).json();
    expect(after.looseSources).toEqual([]);
    expect(after.notebooks[0]).toMatchObject({ title: 'Clayden, Organic Chemistry', sources: 1 });
  });

  it('refuses a source list naming a source that does not exist', async () => {
    const { id } = await create('A');
    recordSource(vault, { book: 'notes', title: 'Notes', authors: [], attribution: 'unknown', origin: { kind: 'file' }, addedAt: '' });
    const bad = await app.request(`/api/notebooks/${id}`, json('PATCH', { sources: ['notes', 'ghost'] }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/no such source: ghost/);
    expect(readNotebooks(vault)[0].sources).toEqual([]);
    // A valid rename riding the same request is not applied either.
    const both = await app.request(`/api/notebooks/${id}`, json('PATCH', { title: 'Renamed', sources: ['ghost'] }));
    expect(both.status).toBe(400);
    expect(readNotebooks(vault)[0].title).toBe('A');
  });

  it('survives a malformed conversation file in a notebook — the view and the list still load', async () => {
    const { id } = await create('A');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(vault, '.harness', 'sessions'), { recursive: true });
    writeFileSync(join(vault, '.harness', 'sessions', 't-bad.json'), JSON.stringify([null, { id: 'x', role: 'assistant', parts: [{}, null] }]));
    await app.request(`/api/notebooks/${id}/threads/t-bad`, { method: 'PUT' });
    expect((await app.request('/api/notebooks')).status).toBe(200);
    const detail = await app.request(`/api/notebooks/${id}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).topics).toEqual([]);
  });

  it('answers 404 for a missing notebook and 400 for a bad request, changing nothing', async () => {
    expect((await app.request('/api/notebooks/nb-nope')).status).toBe(404);
    expect((await app.request('/api/notebooks/nb-nope/threads/t-1', { method: 'PUT' })).status).toBe(404);
    expect((await app.request('/api/notebooks', json('POST', { title: '' }))).status).toBe(400);
    const { id } = await create('A');
    expect((await app.request(`/api/notebooks/${id}`, json('PATCH', {}))).status).toBe(400);
    expect((await app.request(`/api/notebooks/${id}/threads/..%2Fescape`, { method: 'PUT' })).status).toBe(400);
    expect(readNotebooks(vault).map((n) => n.title)).toEqual(['A']);
  });

  it('renames and deletes, and deleting a conversation takes it out of its notebook', async () => {
    const { id } = await create('A');
    saveThread(vault, 't-1', [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello there friend' }] }]);
    await app.request(`/api/notebooks/${id}/threads/t-1`, { method: 'PUT' });
    const renamed = await (await app.request(`/api/notebooks/${id}`, json('PATCH', { title: 'B' }))).json();
    expect(renamed.title).toBe('B');

    expect((await app.request('/api/thread/t-1', { method: 'DELETE' })).status).toBe(204);
    expect(readNotebooks(vault)[0].threads).toEqual([]);

    expect((await app.request(`/api/notebooks/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(readNotebooks(vault)).toEqual([]);
  });
});
