import { Hono } from 'hono';
import type { Context } from 'hono';
import type { HarnessConfig } from './config.js';
import type { Engram } from './mcp.js';
import { readSources, type SourceRecord } from './provenance.js';
import { listThreads, loadThread, type ThreadSummary } from './sessionStore.js';
import { pagesTouched } from './session.js';
import type { UIMessage } from '../shared/uiMessages.js';
import {
  NotebookNotFound, attachThread, createNotebook, deleteNotebook, detachThread, getNotebook,
  isDue, levelOf, notebookForThread, notebookTopics, readNotebooks, summarizeNotebook,
  updateNotebook, type Level, type Notebook, type StudentEntry,
} from './notebookStore.js';

export interface NotebookTopic {
  slug: string; title: string; level: Level; due: boolean;
  /** Days until the level decays, when it is on a clock (the student ledger's days_left). */
  daysLeft: number | null;
  /** Decayed below the level it was earned at; `was` names that level. */
  slipped: boolean;
  was: Level | null;
  /** The latest recorded misconception, as the tutor worded it. */
  misconception: string | null;
}

/** Page titles listed under a conversation in the notebook view; the rest are its topics'. */
const THREAD_PAGES_SHOWN = 4;

export function buildNotebookRoutes(lw: Engram, cfg: HarnessConfig) {
  const app = new Hono();

  // One read of each underlying fact per request, shared by every notebook the request summarizes:
  // the list view summarizes all of them, and a get_student_state or listSlugs round-trip per
  // notebook would scale the home screen's cost with the number of notebooks.
  async function facts() {
    const [state, slugs] = await Promise.all([
      lw.call('get_student_state', { student: cfg.student }) as Promise<Record<string, StudentEntry | undefined>>,
      lw.listSlugs(),
    ]);
    const existing = new Set(slugs);
    const sources = readSources(cfg.vault);
    const threads = listThreads(cfg.vault);
    // A member thread's file is read once however many notebooks ask about it.
    const touchedCache = new Map<string, string[]>();
    const touched = (threadId: string): string[] => {
      let pages = touchedCache.get(threadId);
      if (!pages) {
        pages = pagesTouched(loadThread(cfg.vault, threadId) as UIMessage[]);
        touchedCache.set(threadId, pages);
      }
      return pages;
    };
    const topicsOf = (nb: Notebook) => notebookTopics(nb, touched, sources, (s) => existing.has(s));
    const summarize = (nb: Notebook) =>
      summarizeNotebook(nb, { topics: topicsOf(nb), threads, sources, state });
    return { state, sources, threads, existing, touched, topicsOf, summarize };
  }

  // Page titles for the topic list. Degrades to slugs rather than failing the notebook view — a
  // topic list with identifiers is still usable, a blank notebook is not.
  async function titles(): Promise<Map<string, string>> {
    try {
      const { pages } = await lw.call('list_pages', {}) as { pages: { slug: string; title?: string }[] };
      return new Map(pages.map((p) => [p.slug, p.title ?? p.slug]));
    } catch (e) {
      console.error('[notebooks] list_pages failed, showing slugs:', e);
      return new Map();
    }
  }

  /** A notebook's topics as the view lists them: due first (the thing to do next), then a
   *  recorded misconception (the thing to fix), then by level, then by name. */
  function topicRows(f: Awaited<ReturnType<typeof facts>>, nb: Notebook, names: Map<string, string>): NotebookTopic[] {
    const order: Record<Level, number> = { practicing: 0, exposed: 1, mastered: 2, unseen: 3 };
    return f.topicsOf(nb)
      .map((slug) => {
        const m = f.state[slug];
        const level = levelOf(m);
        const was = levelOf({ effective: m?.level });
        const last = Array.isArray(m?.misconceptions) ? m!.misconceptions!.at(-1) : undefined;
        return {
          slug, title: names.get(slug) ?? slug, level, due: isDue(m),
          daysLeft: typeof m?.days_left === 'number' ? m.days_left : null,
          slipped: m?.slipped === true,
          was: m?.slipped === true && was !== 'unseen' && was !== level ? was : null,
          misconception: last === undefined || last === null ? null : String(last),
        };
      })
      .sort((a, b) => Number(b.due) - Number(a.due)
        || Number(b.misconception !== null) - Number(a.misconception !== null)
        || order[a.level] - order[b.level] || a.title.localeCompare(b.title));
  }

  const fail = (c: Context, e: unknown) => {
    if (e instanceof NotebookNotFound) return c.json({ error: e.message }, 404);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  };

  const withMessages = (threads: ThreadSummary[]) => threads.filter((t) => t.messages > 0);

  app.get('/api/notebooks', async (c) => {
    const [f, names] = await Promise.all([facts(), titles()]);
    const notebooks = readNotebooks(cfg.vault);
    const filed = new Set(notebooks.flatMap((n) => n.threads));
    const inNotebook = new Set(notebooks.flatMap((n) => n.sources));
    return c.json({
      // Each with the one topic to act on next, so a card on the home screen can offer it: the
      // first in the view's own order that is due, carries a misconception, or is not yet mastered.
      notebooks: notebooks.map((nb) => ({
        ...f.summarize(nb),
        next: topicRows(f, nb, names).find((t) => t.due || t.misconception !== null || t.level !== 'mastered') ?? null,
      })).sort((a, b) => b.lastActive.localeCompare(a.lastActive)),
      // Conversations outside every notebook still have a way back from the home screen. All of
      // them: the home shows the newest few and a "show all", and an older one must stay fileable.
      unfiled: withMessages(f.threads).filter((t) => !filed.has(t.id)),
      // Library sources no notebook uses yet — each one a notebook waiting to be started.
      looseSources: f.sources.filter((s) => !inNotebook.has(s.book))
        .map((s) => ({ book: s.book, title: s.title, authors: s.authors })),
    });
  });

  app.post('/api/notebooks', async (c) => {
    const body = await c.req.json().catch(() => null) as { title?: unknown; sources?: unknown } | null;
    try {
      return c.json(createNotebook(cfg.vault, body?.title, new Date(), {
        sources: body?.sources, known: readSources(cfg.vault),
      }), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/api/notebooks/:id', async (c) => {
    const nb = getNotebook(cfg.vault, c.req.param('id'));
    if (!nb) return c.json({ error: `no notebook "${c.req.param('id')}"` }, 404);
    const [f, names] = await Promise.all([facts(), titles()]);
    const topics = topicRows(f, nb, names);
    const bySource = (s: SourceRecord) => ({ book: s.book, title: s.title, authors: s.authors });
    return c.json({
      notebook: f.summarize(nb),
      // Each with the pages it reached, so three conversations opened by the same Studio button
      // are told apart by what they covered, not only by when.
      threads: withMessages(f.threads).filter((t) => nb.threads.includes(t.id)).map((t) => ({
        ...t,
        pages: f.touched(t.id).filter((slug) => f.existing.has(slug)).slice(0, THREAD_PAGES_SHOWN)
          .map((slug) => names.get(slug) ?? slug),
      })),
      sources: f.sources.filter((s) => nb.sources.includes(s.book)).map(bySource),
      // Every source in the Library, for the "choose sources" list.
      library: f.sources.map(bySource),
      topics,
    });
  });

  app.patch('/api/notebooks/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null) as { title?: unknown; sources?: unknown } | null;
    if (!body || (body.title === undefined && body.sources === undefined)) {
      return c.json({ error: 'nothing to change — send a title or sources' }, 400);
    }
    try {
      return c.json(updateNotebook(cfg.vault, id, body, readSources(cfg.vault)));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.delete('/api/notebooks/:id', (c) => {
    try {
      deleteNotebook(cfg.vault, c.req.param('id'));
      return c.json({ deleted: c.req.param('id') });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.put('/api/notebooks/:id/threads/:threadId', (c) => {
    try {
      return c.json(attachThread(cfg.vault, c.req.param('id'), c.req.param('threadId')));
    } catch (e) {
      return fail(c, e);
    }
  });

  // Unfiling: the conversation goes back to the home screen's unfiled list. Moving is the PUT above.
  app.delete('/api/notebooks/:id/threads/:threadId', (c) => {
    try {
      return c.json(detachThread(cfg.vault, c.req.param('id'), c.req.param('threadId')));
    } catch (e) {
      return fail(c, e);
    }
  });

  // Which notebooks cover a page, for the Page tab's "in <notebook>" links. No student state and no
  // existence check needed: the page was just opened, and membership is all that is asked.
  app.get('/api/page/:slug/notebooks', (c) => {
    const slug = c.req.param('slug');
    const sources = readSources(cfg.vault);
    const touched = (threadId: string) => pagesTouched(loadThread(cfg.vault, threadId) as UIMessage[]);
    return c.json(readNotebooks(cfg.vault)
      .filter((nb) => notebookTopics(nb, touched, sources, () => true).includes(slug))
      .map((nb) => ({ id: nb.id, title: nb.title })));
  });

  app.get('/api/thread/:id/notebook', (c) => {
    const nb = notebookForThread(cfg.vault, c.req.param('id'));
    return c.json(nb ? { id: nb.id, title: nb.title } : null);
  });

  return app;
}
