import { useCallback } from 'react';

/**
 * Arrow-key movement for a `role="tablist"`, per the ARIA APG tabs pattern.
 *
 * The three tab strips in the app (SidePanel, the Graph scope toggle, the exercise brief tabs) all
 * carried `role="tab"` + `aria-selected` and none of them implemented the keyboard half of that
 * contract, so a screen-reader user was told "tab 2 of 4" and then found Left/Right did nothing.
 * Announcing a widget you have not implemented is worse than plain buttons would have been.
 *
 * Pair with a ROVING TABINDEX on the buttons (`tabIndex={selected ? 0 : -1}`): a tablist is one
 * stop in the page's Tab order, and arrows move within it. Without that, Tab walks every tab
 * individually and the arrow keys are redundant.
 *
 * Activation is AUTOMATIC (focus selects), the APG's recommended mode when revealing a panel is
 * cheap — all three strips here just toggle already-mounted content. Manual activation would make
 * the keyboard path strictly worse than the mouse path by requiring an extra Enter.
 */
export function useTablistKeys() {
  return useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    const tabs = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
    );
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    // Only steer when focus is actually on a tab. Otherwise (focus inside a panel that happens to
    // be nested under the strip) arrows must keep their normal meaning — caret movement, scrolling.
    if (i === -1) return;
    e.preventDefault();
    const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length
      : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
        : e.key === 'Home' ? 0 : tabs.length - 1;
    tabs[next].focus();
    tabs[next].click();
  }, []);
}
