// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { NotebookCrumb, NotebookIntro, NotebookView, NotebooksHome, PageNotebooks, notebookStarters, studioActions, studyNowMessage } from '../../src/client/components/Notebooks.js';
import { takePendingAsk } from '../../src/client/lib/pendingAsk.js';

const now = new Date().toISOString();
const summary = {
  id: 'nb-calc', title: 'Calculus I', createdAt: now,
  sources: 1, chats: 2, topics: 3,
  mastery: { mastered: 1, practicing: 1, exposed: 0, unseen: 1 },
  due: 2, lastActive: now,
};
const detail = {
  notebook: summary,
  threads: [
    { id: 't-new', title: 'why is the derivative a limit?', updatedAt: now, messages: 4 },
    { id: 't-old', title: 'limits from scratch', updatedAt: now, messages: 6 },
  ],
  sources: [{ book: 'spivak', title: 'Spivak, Calculus', authors: ['Michael Spivak'] }],
  library: [
    { book: 'spivak', title: 'Spivak, Calculus', authors: ['Michael Spivak'] },
    { book: 'notes', title: 'Lecture notes, week 3', authors: [] },
  ],
  topics: [
    { slug: 'derivative', title: 'Derivative', level: 'practicing', due: true },
    { slug: 'limits', title: 'Limits', level: 'mastered', due: false, daysLeft: 23 },
  ],
};

type Call = { url: string; method: string; body: any };
let calls: Call[];
let routes: Record<string, (c: Call) => { status?: number; body: unknown }>;

beforeEach(() => {
  calls = [];
  routes = {};
  location.hash = '';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const handler = routes[`${call.method} ${url}`];
    if (!handler) throw new Error(`unexpected ${call.method} ${url}`);
    const { status = 200, body } = handler(call);
    return { ok: status < 400, status, json: async () => body } as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('NotebooksHome', () => {
  it('shows each notebook with what is due, its counts and its mastery, and lists loose conversations', async () => {
    routes['GET /api/notebooks'] = () => ({ body: { notebooks: [summary], unfiled: [{ id: 't-loose', title: 'something unrelated', updatedAt: now, messages: 2 }] } });
    render(<NotebooksHome />);
    const card = await screen.findByRole('link', { name: /Calculus I/ });
    expect(card.getAttribute('href')).toBe('#/notebooks/nb-calc');
    expect(within(card).getByText('2 reviews due')).toBeTruthy();
    expect(within(card).getByText('1 source · 2 conversations · 3 topics')).toBeTruthy();
    expect(within(card).getByRole('img').getAttribute('aria-label')).toBe('Topics: 1 mastered, 1 practicing, 1 not started');
    expect(screen.getByRole('link', { name: 'something unrelated' }).getAttribute('href')).toBe('#/t/t-loose');
  });

  it('files a loose conversation under a notebook and refreshes', async () => {
    routes['GET /api/notebooks'] = () => ({ body: { notebooks: [summary], unfiled: [{ id: 't-loose', title: 'something unrelated', updatedAt: now, messages: 2 }] } });
    routes['PUT /api/notebooks/nb-calc/threads/t-loose'] = () => ({ body: { id: 'nb-calc', title: 'Calculus I' } });
    render(<NotebooksHome />);
    fireEvent.change(await screen.findByLabelText('File “something unrelated” under a notebook'), { target: { value: 'nb-calc' } });
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/notebooks')).toHaveLength(2));
    expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/notebooks/nb-calc/threads/t-loose')).toBe(true);
  });

  it('creates a notebook and opens it', async () => {
    routes['GET /api/notebooks'] = () => ({ body: { notebooks: [], unfiled: [] } });
    routes['POST /api/notebooks'] = (c) => ({ status: 201, body: { id: 'nb-new', title: c.body.title } });
    render(<NotebooksHome />);
    expect(await screen.findByText(/No notebooks yet/)).toBeTruthy();
    const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('New notebook'), { target: { value: 'Organic chemistry' } });
    fireEvent.click(create);
    await waitFor(() => expect(location.hash).toBe('#/notebooks/nb-new'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ title: 'Organic chemistry' });
  });

  it('starts a notebook from a loose Library source with that source already in it', async () => {
    routes['GET /api/notebooks'] = () => ({ body: { notebooks: [summary], unfiled: [], looseSources: [{ book: 'clayden', title: 'Clayden, Organic Chemistry', authors: ['Jonathan Clayden'] }] } });
    routes['POST /api/notebooks'] = (c) => ({ status: 201, body: { id: 'nb-org', title: c.body.title } });
    render(<NotebooksHome />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start a notebook from Clayden, Organic Chemistry' }));
    await waitFor(() => expect(location.hash).toBe('#/notebooks/nb-org'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ title: 'Clayden, Organic Chemistry', sources: ['clayden'] });
  });

  it('says what failed when the notebooks cannot load', async () => {
    routes['GET /api/notebooks'] = () => ({ status: 500, body: {} });
    render(<NotebooksHome />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn’t load your notebooks/);
  });
});

describe('NotebookView', () => {
  beforeEach(() => {
    routes['GET /api/notebooks/nb-calc'] = () => ({ body: detail });
  });

  it('lists conversations, sources and topics, due first, with topics opening in the latest conversation', async () => {
    render(<NotebookView id="nb-calc" />);
    expect(await screen.findByRole('heading', { name: 'Calculus I' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'limits from scratch' }).getAttribute('href')).toBe('#/t/t-old');
    expect(screen.getByText('Spivak, Calculus')).toBeTruthy();
    const topics = screen.getByRole('region', { name: 'Topics' });
    const links = within(topics).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Derivative', 'Limits']);
    expect(links[0].getAttribute('href')).toBe('#/t/t-new/page/derivative');
    expect(within(topics).getByText('due')).toBeTruthy();
    expect(within(topics).getByText('mastered · holds 23d')).toBeTruthy();
  });

  it('starts a conversation already filed under the notebook', async () => {
    render(<NotebookView id="nb-calc" />);
    await screen.findByRole('heading', { name: 'Calculus I' });
    (fetch as any).mockImplementationOnce(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: undefined });
      return { ok: true, status: 200, json: async () => ({ id: 'nb-calc', title: 'Calculus I' }) } as Response;
    });
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    await waitFor(() => expect(location.hash).toMatch(/^#\/t\/t-[a-z0-9]+$/));
    const threadId = location.hash.slice('#/t/'.length);
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', url: `/api/notebooks/nb-calc/threads/${threadId}` });
  });

  it('offers reviewing what is due, opening a filed conversation that asks for exactly those topics', async () => {
    render(<NotebookView id="nb-calc" />);
    await screen.findByRole('heading', { name: 'Calculus I' });
    (fetch as any).mockImplementationOnce(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: undefined });
      return { ok: true, status: 200, json: async () => ({ id: 'nb-calc', title: 'Calculus I' }) } as Response;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review 1 due topic' }));
    await waitFor(() => expect(location.hash).toMatch(/^#\/t\/t-[a-z0-9]+$/));
    const threadId = location.hash.slice('#/t/'.length);
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', url: `/api/notebooks/nb-calc/threads/${threadId}` });
    expect(takePendingAsk(threadId)).toEqual({ text: 'Review what is due in Calculus I: Derivative. Check me on each before reteaching anything.' });
    expect(takePendingAsk(threadId)).toBeNull(); // sent once, never twice
  });

  it('a Studio action opens a filed conversation asking for that material, with its command', async () => {
    render(<NotebookView id="nb-calc" />);
    await screen.findByRole('heading', { name: 'Calculus I' });
    (fetch as any).mockImplementationOnce(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: undefined });
      return { ok: true, status: 200, json: async () => ({ id: 'nb-calc', title: 'Calculus I' }) } as Response;
    });
    fireEvent.click(screen.getByRole('button', { name: /Quiz me/ }));
    await waitFor(() => expect(location.hash).toMatch(/^#\/t\/t-[a-z0-9]+$/));
    const ask = takePendingAsk(location.hash.slice('#/t/'.length));
    expect(ask).toEqual({ text: 'Quiz me across Calculus I. One question per page, mixed in order: Derivative, Limits.', command: 'quiz' });
  });

  it('does not open a conversation when filing it failed, and says why', async () => {
    render(<NotebookView id="nb-calc" />);
    await screen.findByRole('heading', { name: 'Calculus I' });
    (fetch as any).mockImplementationOnce(async () =>
      ({ ok: false, status: 404, json: async () => ({ error: 'no notebook "nb-calc"' }) }) as Response);
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t file the conversation: no notebook "nb-calc".');
    expect(location.hash).toBe('');
  });

  it('shows the six most recent conversations, and all of them on request', async () => {
    const threads = Array.from({ length: 8 }, (_, i) => ({ id: `t-${i}`, title: `conversation ${i}`, updatedAt: now, messages: 2 }));
    routes['GET /api/notebooks/nb-calc'] = () => ({ body: { ...detail, threads } });
    render(<NotebookView id="nb-calc" />);
    const region = await screen.findByRole('region', { name: 'Conversations' });
    expect(within(region).getAllByRole('link')).toHaveLength(6);
    fireEvent.click(within(region).getByRole('button', { name: 'show all 8' }));
    expect(within(region).getAllByRole('link')).toHaveLength(8);
    expect(within(region).getByRole('button', { name: 'show recent only' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('chooses sources from the Library and saves the whole list', async () => {
    routes['PATCH /api/notebooks/nb-calc'] = () => ({ body: { id: 'nb-calc', title: 'Calculus I' } });
    render(<NotebookView id="nb-calc" />);
    fireEvent.click(await screen.findByRole('button', { name: 'choose sources' }));
    const spivak = screen.getByRole('checkbox', { name: /Spivak, Calculus/ }) as HTMLInputElement;
    expect(spivak.checked).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Lecture notes, week 3/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save sources' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ sources: ['spivak', 'notes'] });
  });

  it('deletes only after the confirmation, then returns to the home grid', async () => {
    routes['DELETE /api/notebooks/nb-calc'] = () => ({ body: { deleted: 'nb-calc' } });
    render(<NotebookView id="nb-calc" />);
    fireEvent.click(await screen.findByRole('button', { name: 'delete notebook' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toMatch(/Its conversations and sources are kept/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete notebook' }));
    await waitFor(() => expect(location.hash).toBe('#/notebooks'));
  });

  it('says a deleted notebook is gone rather than "nothing written yet"', async () => {
    routes['GET /api/notebooks/nb-calc'] = () => ({ status: 404, body: { error: 'no notebook "nb-calc"' } });
    render(<NotebookView id="nb-calc" />);
    expect((await screen.findByRole('alert')).textContent).toBe('This notebook no longer exists — it may have been deleted.');
  });

  it('renames in place', async () => {
    routes['PATCH /api/notebooks/nb-calc'] = (c) => ({ body: { id: 'nb-calc', title: c.body.title } });
    render(<NotebookView id="nb-calc" />);
    fireEvent.click(await screen.findByRole('button', { name: 'rename' }));
    fireEvent.change(screen.getByLabelText('Notebook name'), { target: { value: 'Calculus 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ title: 'Calculus 1' }));
  });
});

describe('NotebookCrumb', () => {
  it('names the notebook a conversation is filed under', async () => {
    routes['GET /api/thread/t-new/notebook'] = () => ({ body: { id: 'nb-calc', title: 'Calculus I' } });
    render(<NotebookCrumb threadId="t-new" />);
    expect((await screen.findByRole('link', { name: 'Calculus I' })).getAttribute('href')).toBe('#/notebooks/nb-calc');
    expect(screen.getByRole('link', { name: 'Notebooks' }).getAttribute('href')).toBe('#/notebooks');
  });

  it('shows only the way to the notebooks for a loose conversation', async () => {
    routes['GET /api/thread/t-loose/notebook'] = () => ({ body: null });
    render(<NotebookCrumb threadId="t-loose" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Notebooks']);
  });
});

describe('notebookStarters', () => {
  it('offers what is due first, then quizzes on half-learned topics, then new ones, at most four', () => {
    const starters = notebookStarters({
      sources: [],
      topics: [
        { slug: 'a', title: 'Limits', level: 'mastered', due: false },
        { slug: 'b', title: 'Continuity', level: 'unseen', due: false },
        { slug: 'c', title: 'Derivative', level: 'exposed', due: false },
        { slug: 'd', title: 'Chain rule', level: 'practicing', due: true },
        { slug: 'e', title: 'Epsilon–delta', level: 'unseen', due: false },
        { slug: 'f', title: 'Product rule', level: 'unseen', due: false },
      ],
    });
    expect(starters.map((s) => s.text)).toEqual([
      'Review Chain rule with me', 'Quiz me on Derivative', 'Teach me Continuity', 'Teach me Epsilon–delta',
    ]);
  });
  it('falls back to the sources when no page is covered yet', () => {
    const starters = notebookStarters({ topics: [], sources: [{ book: 's', title: 'Spivak, Calculus', authors: [] }] });
    expect(starters).toEqual([{ text: 'What are the main ideas in Spivak, Calculus?', kind: 'new' }]);
  });
});

describe('NotebookIntro', () => {
  it('names the notebook and sends a starter as the first message', () => {
    const onAsk = vi.fn();
    render(<NotebookIntro detail={detail as any} onAsk={onAsk} />);
    expect(screen.getByRole('link', { name: 'Calculus I' }).getAttribute('href')).toBe('#/notebooks/nb-calc');
    fireEvent.click(screen.getByRole('button', { name: /Review Derivative with me/ }));
    expect(onAsk).toHaveBeenCalledWith('Review Derivative with me');
  });
});

describe('studyNowMessage', () => {
  it('names every due topic and nothing else, and offers nothing when none is due', () => {
    expect(studyNowMessage(detail as any)).toBe('Review what is due in Calculus I: Derivative. Check me on each before reteaching anything.');
    expect(studyNowMessage({ ...detail, topics: detail.topics.map((t) => ({ ...t, due: false })) } as any)).toBeNull();
  });
});

describe('studioActions', () => {
  it('grounds every action in the notebook’s own pages, and offers none before it covers a page', () => {
    const actions = studioActions(detail as any);
    expect(actions.map((a) => a.label)).toEqual(['Study guide', 'Quiz me', 'Glossary', 'How it connects']);
    for (const a of actions) expect(a.ask.text).toContain('Derivative, Limits');
    expect(studioActions({ ...detail, topics: [] } as any)).toEqual([]);
  });
});

describe('pendingAsk', () => {
  it('drops a stored value that is not a message instead of sending it', () => {
    sessionStorage.setItem('myelin.pendingAsk.t-x', 'plain old string');
    expect(takePendingAsk('t-x')).toBeNull();
    sessionStorage.setItem('myelin.pendingAsk.t-y', JSON.stringify({ text: 'hi', command: 'not-a-command' }));
    expect(takePendingAsk('t-y')).toEqual({ text: 'hi' });
  });
});

describe('PageNotebooks', () => {
  it('links the page to every notebook that covers it, and shows nothing for one that none cover', async () => {
    routes['GET /api/page/chain-rule/notebooks'] = () => ({ body: [{ id: 'nb-calc', title: 'Calculus I' }] });
    routes['GET /api/page/alkanes/notebooks'] = () => ({ body: [] });
    const { rerender } = render(<PageNotebooks slug="chain-rule" />);
    const link = await screen.findByRole('link', { name: 'in notebook Calculus I' });
    expect(link.getAttribute('href')).toBe('#/notebooks/nb-calc');
    rerender(<PageNotebooks slug="alkanes" />);
    await waitFor(() => expect(screen.queryByRole('link')).toBeNull());
  });
});
