import { useState } from 'react';
import { Runtime } from './runtime.js';
import { Thread } from './components/Thread.js';
import { SidePanel } from './components/SidePanel.js';

export function App() {
  const [mode, setMode] = useState('learn');
  return (
    <Runtime mode={mode}>
      <div className="app">
        <header className="topbar">
          <h1>Loreweaver</h1>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {['learn', 'review', 'quiz', 'freeform'].map((m) => <option key={m}>{m}</option>)}
          </select>
        </header>
        <main className="workspace">
          <Thread />
          <SidePanel />
        </main>
      </div>
    </Runtime>
  );
}
