import { useEffect, useState } from 'react';
import { panelBus, type PanelTab } from '../lib/panelBus.js';
import { GraphPanel } from './GraphPanel.js';
import { LibraryPanel } from './LibraryPanel.js';
import { PagePanel } from './PagePanel.js';

export function SidePanel() {
  const [tab, setTab] = useState<PanelTab>('stage');
  const [pageSlug, setPageSlug] = useState<string | null>(null);
  useEffect(() => panelBus.subscribe((e) => {
    if (e.type === 'openPage') { setPageSlug(e.slug); setTab('page'); }
    if (e.type === 'setTab') setTab(e.tab);
  }), []);
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
