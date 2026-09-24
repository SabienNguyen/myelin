import type { Point } from './buildGraph.js';

// A release under this many screen px of total movement is a click, matching the old d3-drag
// clickDistance(4).
export const CLICK_DISTANCE = 4;

export interface NodeDragDeps {
  hasNode(node: string): boolean;
  toGraph(viewport: Point): Point;
  pin(node: string, x: number, y: number): void;
  release(node: string): void;
  open(node: string): void;
}

/**
 * Press, drag and click on a graph node, for mouse and touch alike. The page opens from sigma's
 * clickNode (a mouse click, or a touch tap), not from the release: a touch release never reached
 * the old mouseup-only handler, so a tap opened nothing, and a touch drag left `dragging` set for
 * the next mouse move to pick up. sigma still emits the click after a node drag (it only counts
 * camera drags), so a release that moved suppresses the click that follows it.
 */
export function createNodeDrag(deps: NodeDragDeps) {
  let dragging: { node: string; downX: number; downY: number; moved: boolean } | null = null;
  let suppressClick = false;
  return {
    down(node: string, x: number, y: number): void {
      dragging = { node, downX: x, downY: y, moved: false };
      suppressClick = false;
    },
    /** True when the move belongs to a node press, so the caller stops sigma panning the camera. */
    move(x: number, y: number): boolean {
      if (!dragging) return false;
      // A poll can drop the node mid-press. The press still owns the pointer until release, so the
      // camera does not start panning under it.
      if (!deps.hasNode(dragging.node)) return true;
      if (Math.hypot(x - dragging.downX, y - dragging.downY) >= CLICK_DISTANCE) dragging.moved = true;
      const p = deps.toGraph({ x, y });
      deps.pin(dragging.node, p.x, p.y);
      return true;
    },
    up(): void {
      if (!dragging) return;
      const { node, moved } = dragging;
      dragging = null;
      // Always released, even under the click distance: a nudged node must not stay fixed.
      deps.release(node);
      suppressClick = moved;
    },
    click(node: string): void {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (deps.hasNode(node)) deps.open(node);
    },
  };
}
