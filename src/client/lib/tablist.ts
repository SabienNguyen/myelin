import { useCallback } from 'react';

interface RovingOptions {
  /** CSS selector for the items this container steers between. */
  selector: string;
  /** Which arrow keys move focus. Horizontal strips ignore Up/Down and vice versa. */
  orientation?: 'horizontal' | 'both';
  /**
   * Activate the newly-focused item as well as focusing it.
   *
   * True for tab strips (the APG's "automatic activation", correct when revealing a panel is cheap —
   * requiring an extra Enter would make the keyboard path strictly worse than the mouse path).
   * False where activating has a side effect the learner may not want yet: arrowing across the graph
   * would otherwise navigate the Page panel on every keypress.
   */
  activateOnFocus?: boolean;
}

/**
 * Roving-focus arrow-key movement for a container of related controls.
 *
 * Pair with a ROVING TABINDEX on the items (`tabIndex={isCurrent ? 0 : -1}`): the container is ONE
 * stop in the page's Tab order and arrows move within it. Without that, Tab walks every item
 * individually and the arrow keys are redundant.
 */
export function useRovingKeys({ selector, orientation = 'horizontal', activateOnFocus = true }: RovingOptions) {
  return useCallback((e: React.KeyboardEvent<Element>) => {
    const forward = e.key === 'ArrowRight' || (orientation === 'both' && e.key === 'ArrowDown');
    const back = e.key === 'ArrowLeft' || (orientation === 'both' && e.key === 'ArrowUp');
    if (!forward && !back && e.key !== 'Home' && e.key !== 'End') return;
    // HTMLElement | SVGElement: the graph's nodes are <g>, which has focus()/click() but is
    // not an HTMLElement.
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement | SVGElement>(`${selector}:not([disabled])`));
    const i = items.indexOf(document.activeElement as HTMLElement | SVGElement);
    // Only steer when focus is actually on one of the items. Otherwise (focus inside a panel that
    // happens to be nested under the container) arrows must keep their normal meaning — caret
    // movement, scrolling.
    if (i === -1 || items.length === 0) return;
    e.preventDefault();
    const next = forward ? (i + 1) % items.length
      : back ? (i - 1 + items.length) % items.length
        : e.key === 'Home' ? 0 : items.length - 1;
    items[next].focus();
    // `focus()` is on HTMLOrSVGElement so it is always there; `click()` is HTMLElement-only. The
    // one caller that activates on focus (the tab strips) is HTML buttons, and the SVG caller sets
    // activateOnFocus false, so this guard is belt-and-braces rather than a live branch.
    if (activateOnFocus && 'click' in items[next]) items[next].click();
  }, [selector, orientation, activateOnFocus]);
}

/**
 * Arrow-key movement for a `role="tablist"`, per the ARIA APG tabs pattern.
 *
 * The three tab strips in the app (SidePanel, the Graph scope toggle, the exercise brief tabs) all
 * carried `role="tab"` + `aria-selected` and none of them implemented the keyboard half of that
 * contract, so a screen-reader user was told "tab 2 of 4" and then found Left/Right did nothing.
 * Announcing a widget you have not implemented is worse than plain buttons would have been.
 */
export function useTablistKeys() {
  return useRovingKeys({ selector: '[role="tab"]', orientation: 'horizontal', activateOnFocus: true });
}
