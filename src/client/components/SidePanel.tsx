import { useEffect, useState } from 'react';
import { panelBus } from '../lib/panelBus.js';
import { PagePanel } from './PagePanel.js';

export function SidePanel() {
  const [tab, setTab] = useState<'stage' | 'graph' | 'page'>('stage');
  const [pageSlug, setPageSlug] = useState<string | null>(null);
  useEffect(() => panelBus.subscribe((e) => {
    if (e.type === 'openPage') { setPageSlug(e.slug); setTab('page'); }
    if (e.type === 'setTab') setTab(e.tab);
  }), []);
  return (
    <aside className="side-panel">
      <nav className="tabs">
        {(['stage', 'graph', 'page'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>
      <div hidden={tab !== 'stage'} id="stage-root" className="tab-body" />
      <div hidden={tab !== 'graph'} id="graph-root" className="tab-body" />
      <div hidden={tab !== 'page'} className="tab-body"><PagePanel slug={pageSlug} /></div>
    </aside>
  );
}
