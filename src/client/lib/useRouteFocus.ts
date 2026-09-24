import { useEffect, type RefObject } from 'react';

/** Move focus to a screen's heading when it mounts. A hash route swaps the whole main region, and
 * without this the focused control (a notebook row, the crumb) is gone and focus falls to <body>,
 * so a keyboard or screen-reader user starts over from the top of the page. The target needs
 * tabIndex={-1} to be focusable. */
export function useFocusOnMount(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    ref.current?.focus();
  }, [ref]);
}
