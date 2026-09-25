// The colour scheme: the OS's until the learner picks one with the topbar toggle, then theirs,
// remembered. It lives as data-theme on <html>, which styles.css's light tokens key on, so the one
// attribute drives the CSS and every canvas that resolves tokens into colours (GraphPanel, Mermaid).
// index.html sets the attribute before first paint with an inline copy of resolveScheme, or a saved
// light choice flashed the dark default while the bundle loaded.
export type Scheme = 'light' | 'dark';

const KEY = 'myelin.theme';
const CHANGE = 'myelin:scheme';

function savedScheme(): Scheme | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null; // storage unavailable: follow the OS
  }
}

function systemScheme(): Scheme {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light' : 'dark';
}

export function resolveScheme(): Scheme {
  return savedScheme() ?? systemScheme();
}

export function currentScheme(): Scheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function apply(scheme: Scheme): void {
  if (document.documentElement.dataset.theme === scheme) return;
  document.documentElement.dataset.theme = scheme;
  window.dispatchEvent(new Event(CHANGE));
}

export function chooseScheme(scheme: Scheme): void {
  try {
    localStorage.setItem(KEY, scheme);
  } catch { /* storage unavailable: the choice holds for this session, it just won't survive */ }
  apply(scheme);
}

/** Applies the resolved scheme now, and again whenever the OS scheme changes while the learner has
 *  not picked one. Called once, from main.tsx. */
export function initScheme(): void {
  apply(resolveScheme());
  if (typeof window.matchMedia !== 'function') return;
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (savedScheme() === null) apply(systemScheme());
  });
}

export function onSchemeChange(cb: () => void): () => void {
  window.addEventListener(CHANGE, cb);
  return () => window.removeEventListener(CHANGE, cb);
}
