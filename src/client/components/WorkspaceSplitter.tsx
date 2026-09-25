import { useRef } from 'react';

// One keyboard step (spec: ArrowLeft/ArrowRight move the panel edge 24px; Shift steps 4x).
export const STEP = 24;
// A drag that ends with the panel narrower than this collapses it instead of resting there — see
// onPointerUp below for why the LIVE (moving) width is still clamped to `min`, never this lower.
export const COLLAPSE_THRESHOLD = 240;

export interface WorkspaceSplitterProps {
  /** id of the side panel this separator resizes — WAI-ARIA window-splitter's aria-controls. */
  panelId: string;
  /** Current committed width, px. */
  width: number;
  min: number;
  max: number;
  /** A clamped LIVE width: every keyboard step, and every pointermove while dragging. Render the
   *  visual position from this, but never persist it here — a drag fires it far more often than
   *  it should hit storage, and a value reported mid-drag isn't final until onWidthCommit says so
   *  (see that prop's comment for the collapse case this is protecting against). */
  onWidthChange: (width: number) => void;
  /** The width to actually persist: fired once immediately after onWidthChange for a keyboard
   *  step (a keypress is already a finished action), and once when a drag releases resting above
   *  COLLAPSE_THRESHOLD. NOT fired when a drag releases below the threshold — onCollapse fires
   *  instead, and the width persisted before the drag started is exactly what should still be
   *  there for the next expand (dragging a 600px panel shut must restore 600, not whatever width
   *  the pointer was passing through when it crossed the threshold). */
  onWidthCommit: (width: number) => void;
  /** Enter, or a drag released below COLLAPSE_THRESHOLD. */
  onCollapse: () => void;
  /** Double-click: back to the fluid default split, not a specific px value. */
  onResetDefault: () => void;
}

/**
 * The boundary between the chat column and the side panel, per the WAI-ARIA window-splitter
 * pattern (role="separator", not a button — a splitter reports a live numeric position the way a
 * slider does, which `<button>` has no ARIA vocabulary for).
 *
 * Dragging: the LIVE width reported through onWidthChange while the pointer moves is clamped to
 * `min`, so the panel never visibly shrinks past its resting minimum while still tracking the
 * cursor (a "resistance" feel, same idea as a native OS window refusing to shrink past its floor).
 * Whether to collapse is decided separately at release, from the RAW (unclamped) pointer position
 * — that is what lets a fast drag well past the 240px line actually collapse the panel instead of
 * just resting at 320.
 *
 * Persistence is likewise split from the live position: onWidthChange fires on every pointermove
 * and must stay cheap and non-persisting, while onWidthCommit fires once — at release above the
 * threshold, or once per keyboard step — so a caller backed by localStorage writes it exactly
 * once per finished gesture instead of once per animation frame.
 */
export function WorkspaceSplitter({
  panelId, width, min, max, onWidthChange, onWidthCommit, onCollapse, onResetDefault,
}: WorkspaceSplitterProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const clamp = (w: number) => Math.min(max, Math.max(min, w));

  // A keyboard step is one discrete action, not a stream like a drag — report and persist it in
  // the same breath.
  function step(w: number) {
    onWidthChange(w);
    onWidthCommit(w);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const delta = e.shiftKey ? STEP * 4 : STEP;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(clamp(width + delta)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(clamp(width - delta)); }
    else if (e.key === 'Home') { e.preventDefault(); step(min); }
    else if (e.key === 'End') { e.preventDefault(); step(max); }
    else if (e.key === 'Enter') { e.preventDefault(); onCollapse(); }
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: width };
    document.body.classList.add('panel-resizing');
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const raw = drag.startWidth - (e.clientX - drag.startX);
    onWidthChange(clamp(raw));
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    document.body.classList.remove('panel-resizing');
    const raw = drag.startWidth - (e.clientX - drag.startX);
    if (raw < COLLAPSE_THRESHOLD) onCollapse();
    else onWidthCommit(clamp(raw));
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side panel"
      aria-controls={panelId}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(clamp(width))}
      tabIndex={0}
      className="workspace-splitter"
      onKeyDown={onKeyDown}
      onDoubleClick={onResetDefault}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
