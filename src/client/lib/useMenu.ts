import { useEffect, type RefObject } from 'react';

/**
 * APG menu-button keyboard and pointer handling for a topbar dropdown (HistoryMenu, the notebook
 * crumb): focus the first item on open, arrows/Home/End move between `[role="menuitem"]`s, Escape
 * closes and returns focus to the trigger, Tab and an outside click close. `paused` hands the keys
 * back to the page while an inline alertdialog inside the menu has focus — its Tab and Escape
 * belong to the dialog.
 */
export function useMenu(opts: {
  open: boolean;
  close: () => void;
  rootRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  paused?: boolean;
}) {
  const { open, close, rootRef, panelRef, triggerRef, paused = false } = opts;

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, panelRef]);

  useEffect(() => {
    if (!open || paused) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        triggerRef.current?.focus();
        return;
      }
      if (e.key === 'Tab') {
        // APG menus close on tab-out; no focus trap — let the browser move focus naturally.
        close();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      const items = panelRef.current
        ? Array.from(panelRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        : [];
      if (items.length === 0) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLElement);
      let next: number;
      if (e.key === 'ArrowDown') next = i === -1 ? 0 : (i + 1) % items.length;
      else if (e.key === 'ArrowUp') next = i === -1 ? items.length - 1 : (i - 1 + items.length) % items.length;
      else if (e.key === 'Home') next = 0;
      else next = items.length - 1;
      items[next]?.focus();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, paused, close, rootRef, panelRef, triggerRef]);
}
