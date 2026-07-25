import { useEffect, useState } from 'react';
import { panelBus, type PanelTab } from '../lib/panelBus.js';
import { parseHash, serializeHash } from '../lib/urlState.js';
import { GraphPanel } from './GraphPanel.js';
import { LibraryPanel } from './LibraryPanel.js';
import { PagePanel } from './PagePanel.js';
import { useTablistKeys } from '../lib/tablist.js';

export function SidePanel() {
  const onTabKeys = useTablistKeys();
  const [tab, setTab] = useState<PanelTab>(() => parseHash(location.hash).tab);
  const [pageSlug, setPageSlug] = useState<string | null>(() => parseHash(location.hash).pageSlug);
  useEffect(() => panelBus.subscribe((e) => {
    if (e.type === 'openPage') { setPageSlug(e.slug); setTab('page'); }
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

  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseHash(location.hash);
      setTab(parsed.tab);
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
          >{t}</button>
        ))}
      </nav>
      <div hidden={tab !== 'stage'} id="stage-root" className="tab-body" role="tabpanel" aria-labelledby="tab-stage" />
      <div hidden={tab !== 'graph'} id="panel-graph" className="tab-body" role="tabpanel" aria-labelledby="tab-graph"><GraphPanel visible={tab === 'graph'} /></div>
      <div hidden={tab !== 'page'} id="panel-page" className="tab-body" role="tabpanel" aria-labelledby="tab-page"><PagePanel slug={pageSlug} /></div>
      <div hidden={tab !== 'library'} id="panel-library" className="tab-body" role="tabpanel" aria-labelledby="tab-library"><LibraryPanel visible={tab === 'library'} /></div>
    </aside>
  );
}
