import { useEffect, useState } from 'react';
import { panelBus, type PanelTab } from '../lib/panelBus.js';
import { parseHash, serializeHash } from '../lib/urlState.js';
import { GraphPanel } from './GraphPanel.js';
import { LibraryPanel } from './LibraryPanel.js';
import { PagePanel } from './PagePanel.js';

export function SidePanel() {
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
      <nav className="tabs">
        {(['stage', 'graph', 'page', 'library'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} aria-selected={tab === t} role="tab" onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>
      <div hidden={tab !== 'stage'} id="stage-root" className="tab-body" />
      <div hidden={tab !== 'graph'} className="tab-body"><GraphPanel visible={tab === 'graph'} /></div>
      <div hidden={tab !== 'page'} className="tab-body"><PagePanel slug={pageSlug} /></div>
      <div hidden={tab !== 'library'} className="tab-body"><LibraryPanel visible={tab === 'library'} /></div>
    </aside>
  );
}
