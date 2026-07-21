// Ported VERBATIM from ~/Dev/personal/the-gap apps/web/src/hooks/useDebouncedRun.ts (READ ONLY
// there). Auto-run debounce: "Tests auto-run 900ms after typing pause. NO run button needed."
// Calls `run(code)` DEBOUNCE_MS after the last change to `code` — a fresh keystroke resets the
// timer. `run` is read through a ref so callers don't need to memoize it to avoid re-triggering
// the debounce on every render.

import { useEffect, useRef } from 'react';

export const DEBOUNCE_MS = 900;

export function useDebouncedRun(code: string, run: (code: string) => void, delayMs: number = DEBOUNCE_MS): void {
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const timer = setTimeout(() => runRef.current(code), delayMs);
    return () => clearTimeout(timer);
  }, [code, delayMs]);
}
