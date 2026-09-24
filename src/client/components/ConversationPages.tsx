// The Stage's resting state: the pages this conversation has worked on, with where the learner
// stands on each — a lesson outline that builds itself as the conversation goes (Khan Academy's
// "in this lesson"), instead of a placeholder that says exercises will appear here. Which pages is
// shared/topics.ts's reading, the same one a notebook's topics come from.
import { useEffect, useMemo, useState } from 'react';
import type { UIMessage } from '../../shared/uiMessages.js';
import { pagesTouched } from '../../shared/topics.js';
import { getGraph } from '../lib/api.js';
import { panelBus } from '../lib/panelBus.js';
import { LEVEL_LABEL, asMasteryLevel, type MasteryLevel as Level } from '../lib/mastery.js';

interface Row { slug: string; title: string; level: Level }

export function ConversationPages({ messages, isRunning = false }: { messages: UIMessage[]; isRunning?: boolean }) {
  const slugs = useMemo(() => pagesTouched(messages), [messages]);
  const key = slugs.join('\n');
  const [known, setKnown] = useState<Map<string, { title: string; level: Level }>>(new Map());

  // Titles and levels come from the graph payload, which the server caches. Refetched when the SET
  // of pages changes and again whenever a turn settles — evidence recorded on a page already in the
  // list changes its level without changing the set — but never mid-turn, per streamed token.
  useEffect(() => {
    if (slugs.length === 0 || isRunning) return;
    let cancelled = false;
    getGraph()
      .then((g) => {
        if (cancelled) return;
        const m = new Map<string, { title: string; level: Level }>();
        for (const n of (g.nodes ?? []) as any[]) {
          m.set(n.slug, {
            title: typeof n.title === 'string' ? n.title : n.slug,
            level: asMasteryLevel(n?.mastery?.effective),
          });
        }
        setKnown(m);
      })
      // Without the graph the list still shows, by slug and without a level — logged, not hidden.
      .catch((e) => console.error('[stage] could not load page titles:', e));
    return () => { cancelled = true; };
  }, [key, isRunning]);

  if (slugs.length === 0) return null;
  const rows: Row[] = slugs.map((slug) => ({
    slug,
    title: known.get(slug)?.title ?? slug.replace(/-/g, ' '),
    level: known.get(slug)?.level ?? 'unseen',
  }));
  return (
    <section className="stage-pages" aria-labelledby="stage-pages-h">
      <h2 id="stage-pages-h">In this conversation</h2>
      <ul>
        {rows.map((r) => (
          <li key={r.slug}>
            <button type="button" onClick={() => panelBus.openPage(r.slug)}>
              <span className={`nb-dot nb-level-${r.level}`} aria-hidden="true" />
              <span className="stage-pages-title">{r.title}</span>
              <span className="stage-pages-level">{LEVEL_LABEL[r.level]}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
