import { useEffect, useRef, useState } from 'react';
import { panelBus, type PanelTab } from '../lib/panelBus.js';
import { parseHash, serializeHash } from '../lib/urlState.js';
import { GraphPanel } from './GraphPanel.js';
import { LibraryPanel } from './LibraryPanel.js';
import { PagePanel } from './PagePanel.js';
import { SourceReader } from './SourceReader.js';
import { useTablistKeys } from '../lib/tablist.js';

// How often the tab strip re-asks how much is due. Slow on purpose: due-ness changes on the scale
// of days; the only same-session change is reinforcement clearing an item, and switching to the
// Library re-fetches anyway.
const DUE_POLL_MS = 5 * 60_000;

export function SidePanel() {
  const onTabKeys = useTablistKeys();
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
  useEffect(() => panelBus.subscribe((e) => {
    if (e.type === 'openPage') { setPageSlug(e.slug); setSource(null); setTab('page'); }
    if (e.type === 'openSource') { setSource({ path: e.path, title: e.title }); setTab('page'); }
    if (e.type === 'setTab') setTab(e.tab);
  }), []);

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
      const parsed = parseHash(location.hash);
      setTab(parsed.tab);
      // A hash that names a NEW page is an explicit navigation to the compiled page — deep links
      // and browser back both arrive here, and with the reader open they landed behind it: the
      // hash said dilution-calculator while the panel still showed the raw source.
      if (parsed.pageSlug && parsed.pageSlug !== slugRef.current) setSource(null);
      setPageSlug(parsed.pageSlug);
    };
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onHashChange);
    };
  }, []);

  return (
    <aside className="side-panel">
      {/* The buttons carried role="tab" with no role="tablist" owning them — an orphaned tab is not
          a valid ARIA structure, so assistive tech got neither the set-size announcement nor a
          reason to route arrow keys here. */}
      <nav className="tabs" role="tablist" aria-label="Workspace panels" onKeyDown={onTabKeys}>
        {(['stage', 'graph', 'page', 'library'] as const).map((t) => (
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
            onClick={() => setTab(t)}
          >
            {t}
            {t === 'library' && dueCount > 0 && (
              <span className="tab-due-badge" aria-label={`${dueCount} pages due for review`}>{dueCount}</span>
            )}
          </button>
        ))}
      </nav>
      <div hidden={tab !== 'stage'} id="stage-root" className="tab-body" role="tabpanel" aria-labelledby="tab-stage" />
      <div hidden={tab !== 'graph'} id="panel-graph" className="tab-body" role="tabpanel" aria-labelledby="tab-graph"><GraphPanel visible={tab === 'graph'} /></div>
      <div hidden={tab !== 'page'} id="panel-page" className="tab-body" role="tabpanel" aria-labelledby="tab-page">
        {source
          ? <SourceReader path={source.path} title={source.title} onClose={() => setSource(null)} />
          : <PagePanel slug={pageSlug} visible={tab === 'page'} />}
      </div>
      <div hidden={tab !== 'library'} id="panel-library" className="tab-body" role="tabpanel" aria-labelledby="tab-library"><LibraryPanel visible={tab === 'library'} /></div>
    </aside>
  );
}
