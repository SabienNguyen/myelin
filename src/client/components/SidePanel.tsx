import { useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  BooksIcon, FileTextIcon, GraphIcon, PresentationIcon, SidebarSimpleIcon,
} from '@phosphor-icons/react';
import { ChatStoreContext } from '../chatCore/index.js';
import { StageSummary } from './StageSummary.js';
import { ConversationPages } from './ConversationPages.js';
import { getGraph } from '../lib/api.js';
import { panelBus, type PanelTab } from '../lib/panelBus.js';
import { parseHash, parseNotebookRoute, serializeHash } from '../lib/urlState.js';
import { GraphPanel } from './GraphPanel.js';
import { LibraryPanel } from './LibraryPanel.js';
import { PagePanel } from './PagePanel.js';
import { SourceReader } from './SourceReader.js';
import { useRovingKeys, useTablistKeys } from '../lib/tablist.js';
import { ErrorBoundary } from './ErrorBoundary.js';

// How often the tab strip re-asks how much is due. Slow on purpose: due-ness changes on the scale
// of days; the only same-session change is reinforcement clearing an item, and switching to the
// Library re-fetches anyway.
const DUE_POLL_MS = 5 * 60_000;

/** One tab's crash (a malformed page payload, a graph bug) costs that tab, not the whole window. */
function TabBoundary({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <ErrorBoundary label={label} fallback={<p className="panel-error" role="alert">the {label} could not be shown — reload, or pick another tab</p>}>
      {children}
    </ErrorBoundary>
  );
}

const TAB_ORDER = ['stage', 'graph', 'page', 'library'] as const;
// One icon per tab for the collapsed rail (icon-only at desktop widths — see styles.css). A stage
// is a presentation surface; the other three are literal. Declared in phosphor.d.ts, which augments
// @phosphor-icons/react with only the icons the app uses — see that file's own comment for why.
const TAB_ICONS: Record<PanelTab, ReactNode> = {
  stage: <PresentationIcon size={18} aria-hidden="true" />,
  graph: <GraphIcon size={18} aria-hidden="true" />,
  page: <FileTextIcon size={18} aria-hidden="true" />,
  library: <BooksIcon size={18} aria-hidden="true" />,
};

const PANEL_ID = 'side-panel';

export function SidePanel({
  collapsed, onCollapsedChange,
}: { collapsed: boolean; onCollapsedChange: (collapsed: boolean) => void }) {
  // Optional on purpose: SidePanel can mount outside the chat runtime (standalone panel tests),
  // and the stage summary is a nicety — no store means no summary, never a crash.
  const store = useContext(ChatStoreContext);
  const chat = useSyncExternalStore(
    store?.subscribe ?? (() => () => {}),
    store?.getState ?? (() => null),
  );
  const messages = chat?.messages ?? [];
  const onTabKeys = useTablistKeys();
  // The rail is a VERTICAL tablist (Up/Down primary) rather than the horizontal strip's Left/Right
  // — useRovingKeys always honors Left/Right too (there is no vertical-only mode), which is a
  // harmless superset here, not worth a new hook variant for one call site.
  //
  // activateOnFocus is false here, unlike the horizontal strip: activating a rail tab expands the
  // whole panel and unmounts the rail out from under the very hook steering focus, so the first
  // ArrowDown used to expand the panel and drop focus to <body>. Enter/Space and click still
  // activate — see onRailActivate below, which also moves focus into the expanded strip.
  const onRailKeys = useRovingKeys({ selector: '[role="tab"]', orientation: 'both', activateOnFocus: false });
  const [tab, setTab] = useState<PanelTab>(() => parseHash(location.hash).tab);
  const [pageSlug, setPageSlug] = useState<string | null>(() => parseHash(location.hash).pageSlug);
  // The source reader is a MODE of the Page tab (deliberately not a fifth tab): reading the raw
  // artifact and reading its compiled page are the same seat at the same desk.
  const [source, setSource] = useState<{ path: string; title: string } | null>(null);
  // The due count lives on the TAB, not only inside the Library — review is only optimal when the
  // system reminds you, and a reminder you must open a tab to see is not one.
  const [dueCount, setDueCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () => fetch('/api/due')
      .then((r) => (r.ok ? r.json() : null))
      // `total`, not the capped list length: with 15 slipped pages the badge read 12 — the one
      // number the learner glances at was quietly wrong under load.
      .then((d) => { if (!cancelled && d) setDueCount(d.total ?? (d.due ?? []).length); })
      .catch(() => { /* a missing count is a quiet state, never an error surface */ });
    load();
    const id = setInterval(load, DUE_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  // True once ANYTHING has chosen a tab on purpose — a click, a panelBus event, a hash change.
  // Read by the map-as-home effect below, which must lose every race against a deliberate choice.
  const tabTouchedRef = useRef(false);
  useEffect(() => panelBus.subscribe((e) => {
    // Every one of these is a DELIBERATE navigation (a wiki-link click, a graph node, a code
    // exercise mounting via StagePortal's setTab('stage')) — a collapsed rail must open onto it,
    // unlike the map-as-home effect below, which never touches collapsed at all.
    if (e.type === 'openPage') { tabTouchedRef.current = true; setPageSlug(e.slug); setSource(null); setTab('page'); onCollapsedChange(false); }
    if (e.type === 'openSource') { tabTouchedRef.current = true; setSource({ path: e.path, title: e.title }); setTab('page'); onCollapsedChange(false); }
    if (e.type === 'setTab') { tabTouchedRef.current = true; setTab(e.tab); onCollapsedChange(false); }
  }), [onCollapsedChange]);

  // Set just before a rail tab expands the panel (click, or Enter/Space below) so the effect right
  // after can hand focus to that same tab once it re-mounts in the expanded strip. Without this,
  // expanding via keyboard leaves focus on a now-detached rail button and it falls to <body>.
  const pendingRailFocusRef = useRef<PanelTab | null>(null);
  function activateRailTab(t: PanelTab) {
    tabTouchedRef.current = true;
    pendingRailFocusRef.current = t;
    setTab(t);
    onCollapsedChange(false);
  }
  // Roving focus only moves and never activates on the rail (onRailKeys above) — Enter/Space is the
  // keyboard activation path, mirroring what a click on the rail button already does.
  function onRailActivate(e: React.KeyboardEvent<HTMLElement>) {
    onRailKeys(e);
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // document.activeElement, not e.target: a real keydown's target IS the focused element, but a
    // synthetic one dispatched on the container (as tests do, matching how the rest of this file's
    // keyboard tests drive the roving-focus hooks) targets the container itself.
    const active = document.activeElement as HTMLElement | null;
    if (active?.getAttribute('role') !== 'tab') return;
    e.preventDefault();
    active.click();
  }
  useEffect(() => {
    if (collapsed) return;
    const target = pendingRailFocusRef.current;
    if (!target) return;
    pendingRailFocusRef.current = null;
    document.getElementById(`tab-${target}`)?.focus();
  }, [collapsed]);

  // A deep link straight into a PAGE (a bookmark, a wiki-link's slug) must open even if the last
  // session left the panel collapsed — mount-only, since the hashchange listener below only ever
  // sees CHANGES after this point. A hash that names only a TAB is not a deep link to content: it
  // still selects that tab (below), but the panel stays collapsed — SidePanel's own write-back
  // effect puts a tab-naming hash in the URL on nearly every navigation, and <Runtime key={threadId}>
  // remounts this component on every thread switch, so treating tabExplicit as "open" reopened a
  // deliberately collapsed panel on almost every reload and thread switch.
  useEffect(() => {
    if (parseHash(location.hash).pageSlug) onCollapsedChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Map-as-home: when the hash named NO tab (urlState's tabExplicit — the stage default, not a
  // deep link) and the vault already holds pages the learner can do, open on the graph — the map
  // of what they know is a better home than an empty stage. Same guard shape as App.tsx's
  // coldStartMode effect: the functional updater only ever switches AWAY from the untouched
  // default, so a click, a panelBus setTab, or a hash change that lands before the fetch resolves
  // wins and this does nothing. Graph unreachable → stay put; TopbarStatus owns that failure.
  useEffect(() => {
    if (parseHash(location.hash).tabExplicit) return;
    let cancelled = false;
    getGraph()
      .then((g) => {
        if (cancelled) return;
        const known = (g.nodes ?? []).some((n: any) =>
          n.mastery?.effective === 'practicing' || n.mastery?.effective === 'mastered');
        if (known) setTab((t) => (t === 'stage' && !tabTouchedRef.current ? 'graph' : t));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Deep-linking (T27): SidePanel owns the tab/page slice of the hash. It re-parses the
  // current hash to preserve App's threadId slice, and only writes (via replaceState, so tab
  // flips don't spam browser history) when the serialized result actually differs — otherwise
  // this effect and the hashchange listener below would ping-pong.
  useEffect(() => {
    const current = parseHash(location.hash);
    const nextHash = serializeHash({ threadId: current.threadId, tab, pageSlug });
    if (nextHash !== location.hash) history.replaceState(null, '', nextHash);
  }, [tab, pageSlug]);

  // Mirror of pageSlug for the hashchange handler below, which mounts once and would otherwise
  // close over the first render's value.
  const slugRef = useRef(pageSlug);
  useEffect(() => { slugRef.current = pageSlug; }, [pageSlug]);

  useEffect(() => {
    const onHashChange = () => {
      // Leaving for the notebooks screens unmounts this panel. Reacting first would reset the tab
      // and let the write-back effect above replace `#/notebooks` with a thread hash.
      if (parseNotebookRoute(location.hash)) return;
      const parsed = parseHash(location.hash);
      tabTouchedRef.current = true;
      setTab(parsed.tab);
      // A hash that names a NEW page is an explicit navigation to the compiled page — deep links
      // and browser back both arrive here, and with the reader open they landed behind it: the
      // hash said dilution-calculator while the panel still showed the raw source.
      if (parsed.pageSlug && parsed.pageSlug !== slugRef.current) setSource(null);
      setPageSlug(parsed.pageSlug);
      // pageSlug (not tabExplicit): a hash naming only a tab — Back/Forward through ordinary tab
      // switches, or the un-named stage default — must not reopen a panel the learner collapsed.
      // Only a hash naming an actual page is a deep link to content worth expanding for.
      if (parsed.pageSlug) onCollapsedChange(false);
    };
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onHashChange);
    };
  }, [onCollapsedChange]);

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const collapseShortcut = isMac ? 'Meta+\\' : 'Control+\\';
  const collapseShortcutLabel = isMac ? 'Cmd+\\' : 'Ctrl+\\';

  return (
    <aside id={PANEL_ID} className="side-panel">
      {collapsed ? (
        <div className="panel-rail">
          <button
            type="button"
            className="panel-rail-toggle"
            aria-label="Expand side panel"
            aria-expanded="false"
            aria-controls={PANEL_ID}
            aria-keyshortcuts={collapseShortcut}
            title={`Expand side panel (${collapseShortcutLabel})`}
            onClick={() => onCollapsedChange(false)}
          >
            <SidebarSimpleIcon size={16} aria-hidden="true" />
            <span className="panel-rail-label">Expand</span>
          </button>
          {/* Vertical at desktop widths, horizontal (matching the normal strip) on a phone — see
              styles.css. Outside this nav is the expand button above: a tablist may contain only
              tabs. */}
          <nav
            className="panel-rail-tabs"
            role="tablist"
            aria-label="Workspace panels"
            aria-orientation="vertical"
            onKeyDown={onRailActivate}
          >
            {TAB_ORDER.map((t) => (
              <button
                key={t}
                className={tab === t ? 'on' : ''}
                aria-selected={tab === t}
                aria-controls={t === 'stage' ? 'stage-root' : `panel-${t}`}
                id={`tab-${t}`}
                tabIndex={tab === t ? 0 : -1}
                role="tab"
                onClick={() => activateRailTab(t)}
              >
                {TAB_ICONS[t]}
                <span className="panel-rail-label">
                  {t}
                  {t === 'library' && dueCount > 0 && (
                    <span className="tab-due-badge" aria-label={`${dueCount} ${dueCount === 1 ? 'page' : 'pages'} due for review`}>{dueCount}</span>
                  )}
                </span>
              </button>
            ))}
          </nav>
        </div>
      ) : (
        <div className="panel-tabstrip">
          {/* The buttons carried role="tab" with no role="tablist" owning them — an orphaned tab is
              not a valid ARIA structure, so assistive tech got neither the set-size announcement
              nor a reason to route arrow keys here. */}
          <nav className="tabs" role="tablist" aria-label="Workspace panels" onKeyDown={onTabKeys}>
            {TAB_ORDER.map((t) => (
              <button
                key={t}
                className={tab === t ? 'on' : ''}
                aria-selected={tab === t}
                // Stage's panel keeps the id #stage-root — StagePortal resolves its portal target by
                // that exact id, and an element gets one id, so aria-controls points at the real node
                // rather than a panel-stage that would not exist.
                aria-controls={t === 'stage' ? 'stage-root' : `panel-${t}`}
                id={`tab-${t}`}
                // Roving tabindex: the strip is ONE stop in the page's Tab order and arrows move
                // within it, rather than Tab walking all four.
                tabIndex={tab === t ? 0 : -1}
                role="tab"
                onClick={() => { tabTouchedRef.current = true; setTab(t); }}
              >
                {t}
                {t === 'library' && dueCount > 0 && (
                  <span className="tab-due-badge" aria-label={`${dueCount} ${dueCount === 1 ? 'page' : 'pages'} due for review`}>{dueCount}</span>
                )}
              </button>
            ))}
          </nav>
          {/* Outside the tablist above on purpose, same reason as the rail's expand button. */}
          <button
            type="button"
            className="panel-collapse-toggle"
            aria-label="Collapse side panel"
            aria-expanded="true"
            aria-controls={PANEL_ID}
            aria-keyshortcuts={collapseShortcut}
            title={`Collapse side panel (${collapseShortcutLabel})`}
            onClick={() => onCollapsedChange(true)}
          >
            <SidebarSimpleIcon size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      <div hidden={collapsed || tab !== 'stage'} id="stage-root" className="tab-body" role="tabpanel" aria-labelledby="tab-stage">
        <section className="stage-empty">
          <h2>Your workspace</h2>
          <p>Exercises and feedback appear here as you learn.</p>
          <div className="stage-empty-actions">
            <button type="button" onClick={() => panelBus.setTab('library')}>Browse library</button>
            <button type="button" onClick={() => panelBus.setTab('graph')}>Explore knowledge graph</button>
          </div>
        </section>
        {/* Siblings of the placeholder, not inside it: the :has rule that hides the placeholder once
            anything else is on the Stage hid the outline with it after the first answered block. */}
        <TabBoundary label="exercise summary">
          <StageSummary messages={messages} isRunning={chat?.isRunning ?? false} onRetry={(id) => store?.retryGrading(id)} />
        </TabBoundary>
        <TabBoundary label="page outline">
          <ConversationPages messages={messages} isRunning={chat?.isRunning ?? false} />
        </TabBoundary>
      </div>
      <div hidden={collapsed || tab !== 'graph'} id="panel-graph" className="tab-body" role="tabpanel" aria-labelledby="tab-graph">
        <TabBoundary label="graph"><GraphPanel visible={!collapsed && tab === 'graph'} /></TabBoundary>
      </div>
      <div hidden={collapsed || tab !== 'page'} id="panel-page" className="tab-body" role="tabpanel" aria-labelledby="tab-page">
        {/* Keyed by what it shows, so opening another page recovers from one that crashed. */}
        <TabBoundary key={source ? `src:${source.path}` : `page:${pageSlug}`} label="page">
          {source
            ? <SourceReader path={source.path} title={source.title} onClose={() => setSource(null)} />
            : <PagePanel slug={pageSlug} visible={!collapsed && tab === 'page'} />}
        </TabBoundary>
      </div>
      <div hidden={collapsed || tab !== 'library'} id="panel-library" className="tab-body" role="tabpanel" aria-labelledby="tab-library">
        <TabBoundary label="library"><LibraryPanel visible={!collapsed && tab === 'library'} /></TabBoundary>
      </div>
    </aside>
  );
}
