import { useSyncExternalStore } from 'react';

/** Whether `query` matches now, re-rendering when that changes. False where matchMedia is missing
 *  (jsdom, old embedders): the desktop layout is the default everywhere else in the client. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );
}
