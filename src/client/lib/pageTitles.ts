// One slug <-> title lookup shared by every surface that must name a page from a slug alone, or
// find a page from its title alone: the tool-call chips in the transcript (ToolStatusChip), an
// unlabeled `[[slug]]` wiki link (WikiLink, in MarkdownText.tsx), and a `#/cite/<title>` citation
// chip (also WikiLink) that must resolve back to the page it names. These used to invent a
// "title" by reading the slug's hyphens as spaces, because neither a real read_page result (an
// MCP envelope, `{ content: [{ type: 'text', text: '<JSON>' }] }`, not a parsed object) nor a bare
// `[[slug]]` carries a title. The graph payload the server already caches does — `getGraph()`
// resolves `{ nodes: [{ slug, title, … }] }`, the same shape ConversationPages.tsx reads titles
// from.
//
// A module-level cache, not a per-component fetch: a single transcript can mount a dozen chips and
// wiki links for the same handful of slugs in one paint, and each firing its own /api/graph call
// would be the N-fetches-for-one-answer bug this file exists to avoid.
import { useEffect, useSyncExternalStore } from 'react';
import { getGraph } from './api.js';

// Applies across every caller, not per-slug — a conversation with several pages missing from the
// loaded cache must still cost at most one extra /api/graph call every 15s, not one per slug.
const REFETCH_MS = 15_000;

let titles = new Map<string, string>();
// Reverse of `titles`, built alongside it in the same load() — a citation chip names a page by
// title (WikiLink's `#/cite/<title>` href) and must resolve it back to a slug without a second
// fetch or a second cache. Exact title first; `byTitleLower` is the fallback for a model that
// paraphrased a page's title's casing when it cited it.
let byTitle = new Map<string, string>();
let byTitleLower = new Map<string, string>();
// 0 ("never fetched") sits far outside REFETCH_MS of any real Date.now(), so the very first
// caller's miss always fetches with no separate cold-start case to maintain.
let lastFetchAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => { listeners.delete(onStoreChange); };
}

/** The one place that calls getGraph(). Replaces the whole cache with the fresh payload — like
 *  ConversationPages.tsx's own graph read, this trusts /api/graph to answer for the entire vault
 *  each time, not a partial update this would need to merge. */
function load(): Promise<void> {
  lastFetchAt = Date.now();
  const attempt = getGraph()
    .then((g) => {
      const next = new Map<string, string>();
      const nextByTitle = new Map<string, string>();
      const nextByTitleLower = new Map<string, string>();
      for (const n of (g?.nodes ?? []) as any[]) {
        if (typeof n?.slug !== 'string' || typeof n?.title !== 'string') continue;
        next.set(n.slug, n.title);
        // First slug wins a duplicate title — arbitrary but stable, rather than flipping
        // between two pages on every reload of a vault with a repeated title.
        if (!nextByTitle.has(n.title)) nextByTitle.set(n.title, n.slug);
        const lower = n.title.toLowerCase();
        if (!nextByTitleLower.has(lower)) nextByTitleLower.set(lower, n.slug);
      }
      titles = next;
      byTitle = nextByTitle;
      byTitleLower = nextByTitleLower;
      notify();
    })
    .catch((err) => {
      // Callers fall back to the slug read as words (ToolStatusChip, WikiLink) — a learner never
      // sees this fail. Logged so a persistently-unreachable /api/graph is still visible to someone.
      console.error('[titles] could not load page titles:', err);
    })
    .finally(() => { inFlight = null; });
  inFlight = attempt;
  return attempt;
}

/** Starts a fetch when the caller's key (a slug for usePageTitle, a title for
 *  usePageSlugForTitle) can't be answered from what's cached — the very first ask, or a page
 *  written since the last load. `known` is the caller's own cache check, so this one throttle
 *  serves both lookup directions off the one cache. Rate-limited across ALL callers, not per key,
 *  so a conversation touching several not-yet-cached pages in one paint costs one fetch, and a
 *  key that turns out not to exist doesn't retry on every render. */
function ensureFresh(known: boolean): void {
  if (known) return;
  if (inFlight) return;
  if (Date.now() - lastFetchAt < REFETCH_MS) return;
  load();
}

/** Exact title match first, then case-insensitive — a model citing a page by title may not
 *  reproduce its exact casing. */
function findSlugForTitle(title: string): string | undefined {
  return byTitle.get(title) ?? byTitleLower.get(title.toLowerCase());
}

/**
 * A page's title, resolved from the cached graph payload, or `undefined` while it can't be
 * answered yet — not fetched, the fetch failed, or the slug has no page. Callers fall back to
 * something honest (the slug read as words) rather than block on this; a re-render follows once a
 * fetch this hook triggered resolves.
 */
export function usePageTitle(slug: string | null | undefined): string | undefined {
  const title = useSyncExternalStore(subscribe, () => (slug ? titles.get(slug) : undefined));
  useEffect(() => {
    if (slug) ensureFresh(titles.has(slug));
  }, [slug]);
  return title;
}

/**
 * The slug for a page named by its title, resolved from the same cached graph payload
 * usePageTitle reads — the reverse direction, for a citation chip that names a source by title
 * (WikiLink's `#/cite/<title>` href) and must turn it back into an in-app page link. `undefined`
 * while it can't be answered yet, for the same reasons as usePageTitle: not fetched, the fetch
 * failed, or no page has this title (an opaque web-search citation was already dropped before
 * reaching here — see citationLinks in panelBus.ts).
 */
export function usePageSlugForTitle(title: string | null | undefined): string | undefined {
  const slug = useSyncExternalStore(subscribe, () => (title ? findSlugForTitle(title) : undefined));
  useEffect(() => {
    if (title) ensureFresh(findSlugForTitle(title) !== undefined);
  }, [title]);
  return slug;
}
