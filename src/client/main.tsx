import '@fontsource-variable/fraunces/index.css';
import '@fontsource-variable/newsreader/index.css';
// P2 (editor polish): JetBrains Mono for the gap editor's CM6 panes + test console — bundled
// locally via @fontsource, no CDN. 400/700 cover body code text and the PASS/FAIL status labels
// (test-result-status is font-weight 700 — see styles.css).
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
