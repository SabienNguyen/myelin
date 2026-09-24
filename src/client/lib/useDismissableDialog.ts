import { useEffect, useRef, type RefObject } from 'react';

/** Dismissal for the topbar popovers. Escape is heard on the window, not on one input: the
 *  palette's input-only handler went deaf once Tab had carried focus out, leaving the panel drawn
 *  over the page. Escape returns focus to the trigger; a mousedown outside `rootRef` closes without
 *  moving focus, because the learner put it where they clicked. */
export function useDismissableDialog({ open, rootRef, triggerRef, onClose }: {
  open: boolean;
  rootRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close.current();
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, rootRef, triggerRef]);
}
