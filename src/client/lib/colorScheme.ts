// GraphPanel resolved its sigma colours (labelColor, the slip-ring warn colour, the muted
// highlight colour, the --mastery-* node fills) exactly once, at mount, from resolveGraphColors()
// and getComputedStyle(). Switching the OS scheme afterwards left every one of those stale until a
// reload — the labels stayed near-white on a light canvas. useColorScheme is the missing live
// signal: GraphPanel re-resolves its colours and refreshes the renderer whenever this changes.
import { useEffect, useState } from 'react';

const QUERY = '(prefers-color-scheme: light)';

function readScheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia(QUERY).matches ? 'light' : 'dark';
}

/**
 * The OS light/dark preference, live. Queries `prefers-color-scheme: light` rather than `dark`
 * because dark is this app's default (styles.css's `:root` is dark; the light palette lives
 * entirely in the `prefers-color-scheme: light` override) — so both "the query can't run" and "the
 * query explicitly doesn't match light" fall through to the same 'dark' answer.
 *
 * jsdom has no matchMedia, and every component test that renders through this hook runs there —
 * returning 'dark' unconditionally when the API is missing keeps those tests deterministic without
 * a jsdom polyfill, matching the same default a real dark-mode browser would report.
 */
export function useColorScheme(): 'light' | 'dark' {
  const [scheme, setScheme] = useState<'light' | 'dark'>(readScheme);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent | { matches: boolean }) => {
      setScheme(e.matches ? 'light' : 'dark');
    };
    mql.addEventListener('change', onChange as (e: MediaQueryListEvent) => void);
    return () => mql.removeEventListener('change', onChange as (e: MediaQueryListEvent) => void);
  }, []);

  return scheme;
}
