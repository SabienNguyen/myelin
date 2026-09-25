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
  /** A clamped width from a keyboard step or a drag still resting above COLLAPSE_THRESHOLD. */
  onWidthChange: (width: number) => void;
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
 */
export function WorkspaceSplitter({
  panelId, width, min, max, onWidthChange, onCollapse, onResetDefault,
}: WorkspaceSplitterProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const clamp = (w: number) => Math.min(max, Math.max(min, w));

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? STEP * 4 : STEP;
    if (e.key === 'ArrowLeft') { e.preventDefault(); onWidthChange(clamp(width + step)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); onWidthChange(clamp(width - step)); }
    else if (e.key === 'Home') { e.preventDefault(); onWidthChange(min); }
    else if (e.key === 'End') { e.preventDefault(); onWidthChange(max); }
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
