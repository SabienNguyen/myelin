import { useCallback, useState } from 'react';

const WIDTH_KEY = 'myelin.sidePanel.width';
const COLLAPSED_KEY = 'myelin.sidePanel.collapsed';

// Shared with App.tsx (which owns the width math against the measured workspace container) and
// WorkspaceSplitter's tests — one definition of the two hard floors the approved design sets.
export const MIN_PANEL_WIDTH = 320;
export const MIN_CHAT_WIDTH = 420;
// Matches the existing `grid-template-columns: 1.4fr 1fr` split: the panel's share is 1/(1.4+1).
export const DEFAULT_PANEL_FRACTION = 1 / 2.4;

/** No saved width (missing key, blocked storage, or garbage content) means the caller uses its own
 *  fluid default — today's 1.4fr/1fr split — rather than a px value this module would have to
 *  invent. Never throws: a private-browsing session with storage blocked is not a bug report. */
function readStoredWidth(): number | null {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function readStoredCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export interface SidePanelLayout {
  collapsed: boolean;
  /** px, or null when nothing was ever saved (the fluid default split applies). */
  width: number | null;
  setCollapsed: (collapsed: boolean) => void;
  /** null clears the saved width (double-click's "reset to the default split"). */
  setWidth: (width: number | null) => void;
}

/** Persists the side panel's width and collapsed flag per browser (localStorage), read once at
 *  mount and written on every change. Every read and write is wrapped in try/catch — a blocked or
 *  full store degrades to defaults for the rest of the session instead of crashing the workspace. */
export function useSidePanelLayout(): SidePanelLayout {
  const [collapsed, setCollapsedState] = useState<boolean>(readStoredCollapsed);
  const [width, setWidthState] = useState<number | null>(readStoredWidth);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    try { localStorage.setItem(COLLAPSED_KEY, String(next)); } catch { /* session-only fallback */ }
  }, []);

  const setWidth = useCallback((next: number | null) => {
    setWidthState(next);
    try {
      if (next == null) localStorage.removeItem(WIDTH_KEY);
      else localStorage.setItem(WIDTH_KEY, String(Math.round(next)));
    } catch { /* session-only fallback */ }
  }, []);

  return { collapsed, width, setCollapsed, setWidth };
}
