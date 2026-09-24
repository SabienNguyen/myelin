// sigma's own default label/hover drawers (drawDiscNodeLabel, drawDiscNodeHover in
// node_modules/sigma/dist/index-*.cjs.dev.js) always draw a label to the right of the node
// (`fillText(label, data.x + data.size + 3, ...)`) with no regard for the canvas edge, so a node
// near the right side of the panel gets its title clipped mid-word — verified in both colour
// schemes, and worse on the long (40-60 char) titles this graph actually draws. The hover drawer
// also hardcodes a white (#FFF) box with a drop shadow: in the dark scheme that is a near-white
// box behind a near-white label (`--text` is #edeef2), and the shadow breaks the house no-shadow
// rule regardless of scheme. fitLabel/hoverLabelBox below pick a side that actually fits inside
// the canvas; makeLabelDrawers wires them into sigma's own draw-function hooks so GraphPanel can
// override just the drawing, not sigma's node/label layout.
import type { NodeHoverDrawingFunction, NodeLabelDrawingFunction } from 'sigma/rendering';
import type { Settings } from 'sigma/settings';

// Matches sigma's own default offset (`data.x + data.size + 3`), so a label that fits keeps
// exactly the position a learner already sees today.
const LABEL_GAP = 3;
// Kept clear at each canvas edge so a fitted label's own glyphs never touch the frame.
const CANVAS_MARGIN = 4;
const ELLIPSIS = '…';
// Interior padding around the hover box's text, and the corner radius of the box itself.
const HOVER_BOX_PADDING = 4;
const HOVER_BOX_RADIUS = 4;

export interface FitLabelResult {
  text: string;
  x: number;
  align: 'left' | 'right';
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

/** Box geometry for the hover label, which — unlike fitLabel — never truncates: a hovered node is
 *  a deliberate look-up, so the full title should always be legible. Prefers the node's right
 *  side, falls back to the left, and otherwise clamps so the box's left edge stays on-canvas
 *  (`width` can still put its right edge past `canvasWidth` if the label alone is wider than the
 *  whole canvas — an unclippable box beats a silently truncated title). */
export function hoverLabelBox(
  label: string,
  nodeX: number,
  nodeSize: number,
  canvasWidth: number,
  measure: (text: string) => number,
): { x: number; width: number; textX: number } {
  const width = measure(label) + 2 * HOVER_BOX_PADDING;
  const rightX = nodeX + nodeSize + LABEL_GAP;
  const leftX = nodeX - nodeSize - LABEL_GAP - width;

  let x: number;
  if (rightX + width <= canvasWidth) {
    x = rightX;
  } else if (leftX >= 0) {
    x = leftX;
  } else {
    x = Math.max(0, Math.min(rightX, canvasWidth - width));
  }
  return { x, width, textX: x + HOVER_BOX_PADDING };
}

function traceRoundedRect(
  context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number,
): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

/** Wires fitLabel/hoverLabelBox into sigma's own draw-function hooks (the Sigma constructor's
 *  `defaultDrawNodeLabel` / `defaultDrawNodeHover` settings). `getColors`/`getCanvasWidth` are
 *  called on every draw rather than captured once, so a later theme update or panel resize is
 *  picked up without rebuilding the renderer. */
export function makeLabelDrawers(
  getColors: () => { label: string; background: string; border: string },
  getCanvasWidth: () => number,
): { drawNodeLabel: NodeLabelDrawingFunction; drawNodeHover: NodeHoverDrawingFunction } {
  const fontOf = (settings: Settings) => `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;

  const drawNodeLabel: NodeLabelDrawingFunction = (context, data, settings) => {
    if (!data.label) return;
    context.font = fontOf(settings);
    const fit = fitLabel(data.label, data.x, data.size, getCanvasWidth(), (t) => context.measureText(t).width);
    if (fit === null) return;
    context.fillStyle = getColors().label;
    context.textAlign = fit.align;
    context.fillText(fit.text, fit.x, data.y + settings.labelSize / 3);
    context.textAlign = 'left';
  };

  // No shadow: unlike sigma's own drawDiscNodeHover (drop shadow behind a hardcoded white box),
  // this never touches context.shadow* at all, and nothing else on this canvas sets it either.
  const drawNodeHover: NodeHoverDrawingFunction = (context, data, settings) => {
    if (!data.label) return;
    context.font = fontOf(settings);
    const box = hoverLabelBox(data.label, data.x, data.size, getCanvasWidth(), (t) => context.measureText(t).width);
    const colors = getColors();
    const boxHeight = settings.labelSize + 2 * HOVER_BOX_PADDING;

    traceRoundedRect(context, box.x, data.y - boxHeight / 2, box.width, boxHeight, HOVER_BOX_RADIUS);
    context.fillStyle = colors.background;
    context.fill();
    context.lineWidth = 1;
    context.strokeStyle = colors.border;
    context.stroke();

    context.textAlign = 'left';
    context.fillStyle = colors.label;
    context.fillText(data.label, box.textX, data.y + settings.labelSize / 3);
  };

  return { drawNodeLabel, drawNodeHover };
}
