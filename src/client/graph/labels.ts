// sigma's default label drawer (drawDiscNodeLabel in node_modules/sigma/dist/index-*.cjs.dev.js)
// always draws a label to the right of its node (`fillText(label, data.x + data.size + 3, ...)`)
// with no regard for the canvas edge, so a node near the right of the panel had its title clipped
// mid-word — seen in both colour schemes on the long (40-60 character) titles this graph draws.
// Stage padding cannot fix that: it is at most 64px and a title runs to 400. fitLabel picks a side
// that fits inside the canvas; makeLabelDrawer wires it into sigma's own draw hook, so GraphPanel
// overrides only the drawing, never sigma's label grid or layout.
import type { NodeLabelDrawingFunction } from 'sigma/rendering';

// Matches sigma's own default offset (`data.x + data.size + 3`), so a label that fits keeps
// exactly the position a learner already sees today. Exported: themedNodeHover's own text draw
// uses the same gap, so the hover copy lines up with the fitted label instead of drifting from it.
export const LABEL_GAP = 3;
// Kept clear at each canvas edge so a fitted label's own glyphs never touch the frame.
const CANVAS_MARGIN = 4;
const ELLIPSIS = '…';

export interface FitLabelResult {
  text: string;
  x: number;
  align: 'left' | 'right';
}

export interface HoverBoxPlacement {
  align: 'left' | 'right';
  /** Canvas x to anchor the box's node-side point. Equals `nodeX` except in the fallback case
   *  below, where it is shifted just enough to keep the box inside the canvas. */
  x: number;
}

/** Where a node-hover box (its node-side point at `nodeX`, reaching `extent` px further out on
 *  whichever side it attaches to) should sit inside a `canvasWidth`-wide canvas. Tries the right
 *  side first (matches a fitted label that also fits right), falls back to the left, and — for a
 *  node close enough to an edge that neither full box fits — picks the side with more room and
 *  slides the anchor in just far enough to keep the box's outer edge inside the canvas. The box
 *  always carries the full label (see themedNodeHover): hover exists so a learner can read the
 *  whole title, so unlike fitLabel this never truncates. */
export function placeHoverBox(nodeX: number, extent: number, canvasWidth: number): HoverBoxPlacement {
  if (nodeX + extent <= canvasWidth - CANVAS_MARGIN) return { align: 'right', x: nodeX };
  if (nodeX - extent >= CANVAS_MARGIN) return { align: 'left', x: nodeX };

  const rightRoom = canvasWidth - CANVAS_MARGIN - nodeX;
  const leftRoom = nodeX - CANVAS_MARGIN;
  const align: 'left' | 'right' = rightRoom >= leftRoom ? 'right' : 'left';
  const rawX = align === 'right' ? canvasWidth - CANVAS_MARGIN - extent : CANVAS_MARGIN + extent;
  const x = Math.min(Math.max(rawX, CANVAS_MARGIN), canvasWidth - CANVAS_MARGIN);
  return { align, x };
}

/** Where sigma's default node-label drawer would place `label` next to a node at screen-space
 *  `nodeX` (radius `nodeSize`), constrained to stay inside a `canvasWidth`-wide canvas. Tries the
 *  node's right side first (sigma's own default position), falls back to the left, and as a last
 *  resort truncates onto whichever side has more room. Returns null when neither side has room
 *  for more than an ellipsis — better to skip a label than draw one illegible glyph. */
export function fitLabel(
  label: string,
  nodeX: number,
  nodeSize: number,
  canvasWidth: number,
  measure: (text: string) => number,
): FitLabelResult | null {
  const rightX = nodeX + nodeSize + LABEL_GAP;
  const leftX = nodeX - nodeSize - LABEL_GAP;
  const rightRoom = canvasWidth - CANVAS_MARGIN - rightX;
  const leftRoom = leftX - CANVAS_MARGIN;
  const fullWidth = measure(label);

  if (fullWidth <= rightRoom) return { text: label, x: rightX, align: 'left' };
  if (fullWidth <= leftRoom) return { text: label, x: leftX, align: 'right' };

  const align: 'left' | 'right' = rightRoom >= leftRoom ? 'left' : 'right';
  const room = align === 'left' ? rightRoom : leftRoom;
  const text = truncateWithEllipsis(label, room, measure);
  return text === null ? null : { text, x: align === 'left' ? rightX : leftX, align };
}

/** Longest prefix of `label` (trailing spaces trimmed) plus an ellipsis that fits within `room`
 *  px, or null when `room` is too tight for even a couple of characters of it — the label's own
 *  average character width stands in for "a couple of characters" since `measure` is opaque (real
 *  canvas metrics or the test's fixed-width stand-in both work). */
function truncateWithEllipsis(label: string, room: number, measure: (text: string) => number): string | null {
  if (label.length === 0) return null;
  const avgCharWidth = measure(label) / label.length;
  if (room < measure(ELLIPSIS) + 2 * avgCharWidth) return null;
  for (let len = label.length; len > 0; len--) {
    const candidate = `${label.slice(0, len).replace(/\s+$/, '')}${ELLIPSIS}`;
    if (measure(candidate) <= room) return candidate;
  }
  return null;
}

/** sigma's `defaultDrawNodeLabel` with fitLabel's placement. `getColor`/`getCanvasWidth` are
 *  called on every draw rather than captured once, so a scheme change or a panel resize is picked
 *  up without rebuilding the renderer. */
export function makeLabelDrawer(
  getColor: () => string,
  getCanvasWidth: () => number,
): NodeLabelDrawingFunction {
  return (context, data, settings) => {
    if (!data.label) return;
    context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
    const fit = fitLabel(data.label, data.x, data.size, getCanvasWidth(), (t) => context.measureText(t).width);
    if (fit === null) return;
    context.fillStyle = getColor();
    context.textAlign = fit.align;
    context.fillText(fit.text, fit.x, data.y + settings.labelSize / 3);
    context.textAlign = 'left';
  };
}
