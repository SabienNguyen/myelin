import type { PanelTab } from './panelBus.js';

const TAB_VALUES: readonly PanelTab[] = ['stage', 'graph', 'page', 'library'];
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type UrlState = {
  threadId: string;
  tab: PanelTab;
  pageSlug: string | null;
  /** True only when the hash itself NAMED the tab (a `/graph` segment, a `/page/<slug>` deep
   * link). False when `tab` is just the stage default — the distinction map-as-home needs:
   * SidePanel may re-home an un-named default, never a tab someone linked to. */
  tabExplicit: boolean;
};

const DEFAULT_STATE: UrlState = { threadId: 'default', tab: 'stage', pageSlug: null, tabExplicit: false };

/** Hash scheme: `#/t/<threadId>` | `#/t/<threadId>/<tab>` | `#/t/<threadId>/page/<slug>`.
 * Pure and tolerant of junk: anything that doesn't fit the shape (missing segments, unknown
 * tab names, malformed percent-encoding, an invalid threadId) degrades to sane defaults for
 * just the part that's broken rather than throwing or discarding the whole parse. */
export function parseHash(hash: string): UrlState {
  try {
    const raw = hash.replace(/^#\/?/, '');
    const parts = raw.split('/').filter(Boolean);
    if (parts[0] !== 't' || !parts[1]) return { ...DEFAULT_STATE };

    const threadId = THREAD_ID_RE.test(parts[1]) ? parts[1] : 'default';
    const seg2 = parts[2];

    if (seg2 === 'page') {
      const slugRaw = parts.slice(3).join('/');
      return { threadId, tab: 'page', pageSlug: slugRaw ? decodeURIComponent(slugRaw) : null, tabExplicit: true };
    }
    if (seg2 && (TAB_VALUES as readonly string[]).includes(seg2)) {
      return { threadId, tab: seg2 as PanelTab, pageSlug: null, tabExplicit: true };
    }
    return { threadId, tab: 'stage', pageSlug: null, tabExplicit: false };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

// tabExplicit is parse-side only — writing a hash always names the non-default tab, so there is
// nothing for the serializer to read from it.
export function serializeHash(state: Omit<UrlState, 'tabExplicit'>): string {
  const threadId = THREAD_ID_RE.test(state.threadId) ? state.threadId : 'default';
  const base = `#/t/${threadId}`;
  if (state.tab === 'page' && state.pageSlug) return `${base}/page/${encodeURIComponent(state.pageSlug)}`;
  if (state.tab !== 'stage' && state.tab !== 'page') return `${base}/${state.tab}`;
  return base;
}
