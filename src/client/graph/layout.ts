// graphology-layout-forceatlas2 (0.10.1) has no "type": "module" in its package.json, so under this
// project's NodeNext resolution it is treated as a CommonJS module. TS's CJS/ESM interop then folds
// this module's `export default` into "the default import IS the whole module namespace" (which
// mirrors Node's real runtime behaviour for a plain `module.exports = fn` package) — so the type of
// the default import loses `assign`, which exists only on the private, un-exported
// `IForceAtlas2Layout` interface attached to that default value in the library's own index.d.ts.
// Confirmed with `node -e "import('graphology-layout-forceatlas2').then(m => console.log(typeof
// m.default.assign))"` that the runtime value genuinely has the method; the cast below only
// restores type information NodeNext's interop fails to expose, it does not paper over a real gap.
import forceAtlas2Import, { type ForceAtlas2Settings } from 'graphology-layout-forceatlas2';
// The package's own worker SUPERVISOR (worker.js) is not used: it owns the position matrix, so a
// node dragged mid-run was invisible to the worker (every result snapped it back to where the drag
// began, and its neighbours never followed the cursor), and every result it receives is written to
// the graph at once. That second part made sigma re-process every node per iteration, which the
// first WebGL version worked around by pacing iterations to animation frames — and that tied layout
// progress to the frame rate: under software WebGL (headless Chromium, ~300ms frames at 5,000
// nodes) a whole vault got a few dozen iterations before the run cap and stayed a hairball. The loop
// below keeps the package's algorithm (webworker.js wraps iterate.js) and its matrix builder, and
// owns the rest. Declarations for these two internal modules: forceatlas2.d.ts.
import workerFunction from 'graphology-layout-forceatlas2/webworker.js';
import { createWorker, graphToByteArrays } from 'graphology-layout-forceatlas2/helpers.js';
import type { MasteryGraph, Point } from './buildGraph.js';
import { LABEL_GAP } from './labels.js';

interface ForceAtlas2Module {
  assign(graph: MasteryGraph, params: { iterations: number; settings: ForceAtlas2Settings }): void;
}
const forceAtlas2 = forceAtlas2Import as unknown as ForceAtlas2Module;

// The node matrix layout graphToByteArrays builds and iterate.js reads: PPN floats per node, in
// graph.forEachNode order at the time it was built.
const PPN = 10;
const NODE_X = 0;
const NODE_Y = 1;
const NODE_FIXED = 9;

export const LAYOUT = {
  barnesHutAbove: 500, slowDown: 6, gravity: 0.6, scalingRatio: 8,
  // Relative to the graph's own extent, because ForceAtlas2's coordinate scale runs from hundreds to
  // thousands of units (an absolute epsilon of 0.15 was never reached while anything moved). 1%, not
  // the 0.15% the first version used: with the worker iterating freely (hundreds of iterations per
  // check), a converged layout still jitters by 0.4-0.7% of its diagonal per check — measured on a
  // 60-page graph whose extent had stopped changing — so 0.15% was only ever met by the run cap.
  settleCheckMs: 250, settleRelativeEpsilon: 0.01, settleChecks: 2,
  releaseRunMs: 1500, syncIterations: 150,
  // Hard ceiling on how long the worker is allowed to run before we stop it and treat it as
  // settled regardless — see maxRunMsFor. Without this, a graph whose layout never converges
  // (a dense hairball still slowly drifting, or a genuine settle-detection bug) runs the worker
  // forever, and every frame of the run makes sigma re-process and re-upload every node — the
  // cost that starved panning in the first measured run (p50 137ms against a 20ms target).
  maxRunMsCeiling: 12_000, maxRunMsFloor: 3_000, maxRunMsPerNode: 3,
} as const;

/** How long a single layout run is allowed before it is stopped unconditionally, scaled by graph
 *  size: a 17-node contextual view has nothing to gain from 12s of runtime (it settles in well
 *  under a second), but a 5,000-node whole vault may still be usefully spreading out for several
 *  seconds. Pure so it is directly testable without spinning up a worker. */
export function maxRunMsFor(order: number): number {
  return Math.min(LAYOUT.maxRunMsCeiling, Math.max(LAYOUT.maxRunMsFloor, order * LAYOUT.maxRunMsPerNode));
}

export interface LayoutController {
  start(): void;
  stop(): void;
  kill(): void;
  isRunning(): boolean;
  pin(node: string, x: number, y: number): void;
  release(node: string): void;
  onSettle(cb: () => void): () => void;
  setReducedMotion(reduced: boolean): void;
}

/** Mean per-node displacement between `prev` (x0,y0,x1,y1… in graph.forEachNode order) and the
 *  graph now. Pure; used by settle detection. */
export function meanDisplacement(prev: Float64Array, graph: MasteryGraph): number {
  let i = 0;
  let total = 0;
  let count = 0;
  graph.forEachNode((_node, attrs) => {
    const dx = attrs.x - prev[i];
    const dy = attrs.y - prev[i + 1];
    total += Math.sqrt(dx * dx + dy * dy);
    count += 1;
    i += 2;
  });
  return count === 0 ? 0 : total / count;
}

/** Diagonal of the graph's current node bbox, in graph units — the scale settle detection divides
 *  by so the same relative threshold means "settled" for a tight 2-node contextual view and a
 *  sprawling 5,000-node whole vault alike. 0 for an empty or single-point graph (degenerate; the
 *  caller falls back to comparing the raw displacement in that case). */
export function bboxDiagonal(graph: MasteryGraph): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  graph.forEachNode((_node, attrs) => {
    if (attrs.x < minX) minX = attrs.x;
    if (attrs.x > maxX) maxX = attrs.x;
    if (attrs.y < minY) minY = attrs.y;
    if (attrs.y > maxY) maxY = attrs.y;
  });
  return Number.isFinite(minX) ? Math.hypot(maxX - minX, maxY - minY) : 0;
}

export function snapshot(graph: MasteryGraph): Float64Array {
  const out = new Float64Array(graph.order * 2);
  let i = 0;
  graph.forEachNode((_node, attrs) => {
    out[i] = attrs.x;
    out[i + 1] = attrs.y;
    i += 2;
  });
  return out;
}

// Unlinked subjects share one force system: gravity pulls each toward the common centre while
// repulsion pushes them apart, and a small component drifts until the run cap (Rust at about
// (-1000, -950) in a four-subject vault), so the fit frames mostly empty canvas with the rest shrunk
// into clumps. After each settle the components are shelved row by row instead, each keeping its
// own internal layout. The gap scales with the largest component so it reads the
// same at any ForceAtlas2 scale, floored so single-page components do not touch.
const PACK_GAP_FRACTION = 0.08;
const PACK_GAP_MIN = 40;

interface Component { nodes: string[]; minX: number; minY: number; w: number; h: number }

/** The canvas a layout is fitted into, and how far each node's label reaches in screen px. Labels
 *  are drawn at a fixed px size whatever the zoom, so packing by node centres alone put a row of
 *  unlinked pages 20px apart with 200px titles, all forced on, drawn over each other. */
export interface LabelFrame {
  width: number;
  height: number;
  /** sigma's stagePadding. */
  padding: number;
  /** px from the node's centre to the far end of its label, drawn to the right. */
  labelReach: (node: string) => number;
  labelHeight: number;
}

/** Graph units per screen px when sigma fits a `w` x `h` extent into `frame` at camera ratio 1 —
 *  sigma's own normalisation (max side to the unit square) and matrixFromCamera (smallest padded
 *  viewport side, times getCorrectionRatio). */
export function unitsPerPx(frame: LabelFrame, w: number, h: number): number {
  const side = Math.max(w, h);
  const usable = Math.min(frame.width, frame.height) - 2 * frame.padding;
  if (side <= 0 || usable <= 0) return 0;
  const viewportRatio = frame.height / frame.width;
  const graphRatio = h > 0 && w > 0 ? h / w : 1;
  const correction = (viewportRatio < 1 && graphRatio > 1) || (viewportRatio > 1 && graphRatio < 1)
    ? 1
    : Math.min(Math.max(graphRatio, 1 / graphRatio), Math.max(1 / viewportRatio, viewportRatio));
  return side / (usable * correction);
}

// A title wider than the canvas can fit at no scale, so budgeting its full width made the fit
// zoom out without end (u grew 1.6x a round for a 350px title on a 460px panel). Past this share
// of the padded canvas width a label is budgeted as if cut there; fitLabel truncates whatever
// actually runs into the edge.
const LABEL_REACH_MAX = 0.6;

/** Screen px from `node`'s centre to the end of its label, as the packing and the fit budget it. */
export function budgetedReach(frame: LabelFrame, node: string): number {
  return Math.min(frame.labelReach(node), LABEL_REACH_MAX * (frame.width - 2 * frame.padding));
}

interface Extent { minX: number; minY: number; maxX: number; maxY: number }

/** Bbox of `nodes` placed at `at`, including their labels at `u` graph units per px. u = 0 is node
 *  centres only. */
function extentOf(
  graph: MasteryGraph, nodes: Iterable<string>, u: number, frame: LabelFrame | undefined, at: (node: string) => Point,
): Extent {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const halfLabel = frame ? (frame.labelHeight / 2) * u : 0;
  for (const n of nodes) {
    const { x, y } = at(n);
    const radius = frame ? graph.getNodeAttribute(n, 'size') * u : 0;
    const right = frame ? Math.max(budgetedReach(frame, n) * u, radius) : 0;
    const half = Math.max(halfLabel, radius);
    if (x - radius < minX) minX = x - radius;
    if (x + right > maxX) maxX = x + right;
    if (y - half < minY) minY = y - half;
    if (y + half > maxY) maxY = y + half;
  }
  return { minX, minY, maxX, maxY };
}

const attrsAt = (graph: MasteryGraph) => (node: string): Point => graph.getNodeAttributes(node);

// Label reach depends on the scale the fit lands on, which depends on the extent the labels add:
// fixed-point iteration settles it while the labels take up less than the canvas (LABEL_REACH_MAX,
// and the shelf packing, arrange that). u only ever grows: the shelf packing's row width is a
// discrete choice that can flip between rounds, and a u that followed it back down bounced between
// two values forever, missed the tolerance, and dropped a vault that fits to the centres-only
// fallback. Stopping on a u at or above the one the fit lands on only budgets labels more room.
const LABEL_FIT_ROUNDS = 30;
const LABEL_FIT_TOLERANCE = 0.002;

/** The graph-unit bbox that keeps every node AND its label on the canvas once sigma fits it, or
 *  the node centres' bbox when the labels cannot all fit at any zoom (see packComponents). */
export function labelledBBox(graph: MasteryGraph, frame: LabelFrame): { x: [number, number]; y: [number, number] } {
  const at = attrsAt(graph);
  const centres = extentOf(graph, graph.nodes(), 0, undefined, at);
  let e = centres;
  let u = 0;
  for (let i = 0; i < LABEL_FIT_ROUNDS; i++) {
    const next = unitsPerPx(frame, e.maxX - e.minX, e.maxY - e.minY);
    if (next <= u * (1 + LABEL_FIT_TOLERANCE)) return { x: [e.minX, e.maxX], y: [e.minY, e.maxY] };
    u = next;
    e = extentOf(graph, graph.nodes(), u, frame, at);
  }
  return { x: [centres.minX, centres.maxX], y: [centres.minY, centres.maxY] };
}

// ForceAtlas2 knows nothing of labels, and fitting whole titles on the canvas zooms a small
// component down until its nodes sit 10px apart under 14px titles (a five-page Rust chain printed
// as one smear). So each component is swept top to bottom and a labelled node pushed down just far
// enough to sit this many label heights below any title above it that reaches it, carrying every
// node below it along. Minimal and vertical on purpose: titles are wide and short, and scaling the
// whole component to part its closest pair grew it faster than the zoom-out it caused, without end.
const LABEL_SPACING = 1.3;

interface Group { nodes: string[]; labelled: Set<string>; y: Map<string, number> }

function components(graph: MasteryGraph, frame: LabelFrame | undefined): Group[] {
  const seen = new Set<string>();
  const out: Group[] = [];
  graph.forEachNode((start) => {
    if (seen.has(start)) return;
    seen.add(start);
    const nodes = [start];
    for (let i = 0; i < nodes.length; i++) {
      graph.forEachNeighbor(nodes[i], (nb) => {
        if (!seen.has(nb)) { seen.add(nb); nodes.push(nb); }
      });
    }
    const labelled = new Set(frame
      ? nodes.filter((n) => frame.labelReach(n) > graph.getNodeAttribute(n, 'size') + LABEL_GAP)
      : []);
    out.push({ nodes, labelled, y: new Map() });
  });
  return out;
}

/** Where `g`'s nodes sit vertically at `u` graph units per px once no two of its titles overlap
 *  (see LABEL_SPACING). Empty when fewer than two carry a label, which is every component of a
 *  large view: only forced labels count, and those are capped at a contextual view's size. */
function unstack(graph: MasteryGraph, g: Group, u: number, frame: LabelFrame): Map<string, number> {
  const y = new Map<string, number>();
  if (g.labelled.size < 2) return y;
  const rowUnits = LABEL_SPACING * frame.labelHeight * u;
  const order = [...g.nodes].sort((a, b) => graph.getNodeAttribute(a, 'y') - graph.getNodeAttribute(b, 'y') || (a < b ? -1 : 1));
  const placed: string[] = [];
  let shift = 0;
  for (const n of order) {
    const { x } = graph.getNodeAttributes(n);
    let at = graph.getNodeAttribute(n, 'y') + shift;
    if (g.labelled.has(n)) {
      for (const m of placed) {
        const mx = graph.getNodeAttribute(m, 'x');
        const left = mx <= x ? m : n;
        if (Math.abs(mx - x) < budgetedReach(frame, left) * u) at = Math.max(at, y.get(m)! + rowUnits);
      }
      placed.push(n);
    }
    shift = at - graph.getNodeAttribute(n, 'y');
    y.set(n, at);
  }
  return y;
}

const spreadAt = (graph: MasteryGraph, g: Group) => (node: string): Point => {
  const { x, y } = graph.getNodeAttributes(node);
  return { x, y: g.y.get(node) ?? y };
};

function measure(graph: MasteryGraph, groups: Group[], u: number, frame: LabelFrame | undefined): Component[] {
  return groups.map((g) => {
    const e = extentOf(graph, g.nodes, u, frame, spreadAt(graph, g));
    return { nodes: g.nodes, minX: e.minX, minY: e.minY, w: e.maxX - e.minX, h: e.maxY - e.minY };
  });
}

/** Where each component's top-left corner goes when shelved in rows no wider than `rowWidth`, and
 *  the size of the whole. */
function shelve(comps: Component[], gap: number, rowWidth: number): { corners: Point[]; w: number; h: number } {
  const corners: Point[] = [];
  let x = 0, y = 0, rowHeight = 0, w = 0;
  for (const c of comps) {
    if (x > 0 && x + c.w > rowWidth) {
      x = 0;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    corners.push({ x, y });
    w = Math.max(w, x + c.w);
    x += c.w + gap;
    rowHeight = Math.max(rowHeight, c.h);
  }
  return { corners, w, h: y + rowHeight };
}

// Row widths tried per packing: enough to find a shape near the canvas's, without the cost of
// trying every width when a whole vault has thousands of single-page components.
const PACK_WIDTHS_TRIED = 24;

// Kept clear between one component's label and the next component, in screen px.
const PACK_LABEL_GAP_PX = 16;

/** The row width, out of PACK_WIDTHS_TRIED, whose shelf packing fits a canvas of `aspect`
 *  (width / height) at the largest scale. */
function bestShelf(comps: Component[], gap: number, aspect: number): ReturnType<typeof shelve> {
  const widest = Math.max(...comps.map((c) => c.w));
  const oneRow = comps.reduce((sum, c) => sum + c.w + gap, 0);
  let best = shelve(comps, gap, widest);
  let bestScale = -Infinity;
  for (let i = 0; i < PACK_WIDTHS_TRIED; i++) {
    const rowWidth = widest + (oneRow - widest) * (i / (PACK_WIDTHS_TRIED - 1)) ** 2;
    const packed = shelve(comps, gap, rowWidth);
    const scale = Math.min(aspect / Math.max(packed.w, 1), 1 / Math.max(packed.h, 1));
    if (scale > bestScale) { best = packed; bestScale = scale; }
  }
  return best;
}

/** Moves each connected component of `graph` as a whole into a shelf packing, largest first (then
 *  by first node, so repeated settles keep their places), in rows whose width is picked so the whole
 *  fits the canvas at the largest scale. With a `frame`, each component's footprint includes its
 *  labels at the scale the fit will land on, so neighbouring components' titles do not overlap, and
 *  a component whose own titles would overlap is unstacked first (LABEL_SPACING) — a single
 *  component included. Without one, node centres only on a square canvas, and a single component
 *  is left as it is. Any non-finite position leaves the graph as it is. */
export function packComponents(graph: MasteryGraph, frame?: LabelFrame): void {
  const groups = components(graph, frame);
  if (groups.length < 2 && !frame) return;
  groups.sort((a, b) => b.nodes.length - a.nodes.length || (a.nodes[0] < b.nodes[0] ? -1 : 1));
  let comps = measure(graph, groups, 0, undefined);
  if (comps.some((c) => !Number.isFinite(c.w) || !Number.isFinite(c.h))) return;
  const baseGap = Math.max(PACK_GAP_MIN, PACK_GAP_FRACTION * Math.max(comps[0].w, comps[0].h));
  const aspect = frame && frame.height > 0 ? frame.width / frame.height : 1;
  const plainComps = comps;
  let best = bestShelf(comps, baseGap, aspect);
  const plain = best;
  if (frame) {
    let u = 0;
    let converged = false;
    for (let i = 0; i < LABEL_FIT_ROUNDS && !converged; i++) {
      const next = unitsPerPx(frame, best.w, best.h);
      converged = next <= u * (1 + LABEL_FIT_TOLERANCE);
      if (converged) break;
      u = next;
      for (const g of groups) g.y = unstack(graph, g, u, frame);
      comps = measure(graph, groups, u, frame);
      best = bestShelf(comps, Math.max(baseGap, PACK_LABEL_GAP_PX * u), aspect);
    }
    // More forced titles than the canvas holds at any zoom (nine 200px titles on a 460x360 panel):
    // every round zooms out further and unstacks further, without end. Packing by node centres
    // overlaps some titles but keeps the pages themselves in view.
    if (!converged) {
      for (const g of groups) g.y = new Map();
      comps = plainComps;
      best = plain;
    }
  }
  const target = new Map<string, Point>();
  comps.forEach((c, i) => {
    const dx = best.corners[i].x - c.minX;
    const dy = best.corners[i].y - c.minY;
    const at = spreadAt(graph, groups[i]);
    for (const n of c.nodes) {
      const p = at(n);
      target.set(n, { x: p.x + dx, y: p.y + dy });
    }
  });
  graph.updateEachNodeAttributes((node, attrs) => {
    const p = target.get(node)!;
    attrs.x = p.x;
    attrs.y = p.y;
    return attrs;
  }, { attributes: ['x', 'y'] });
}

// A whole-vault screenshot at ~400 nodes showed a hairball: nodes overlapping heavily rather than
// separated by visible gaps. adjustSizes (FA2's own anti-overlap term, which factors node radius
// into repulsion) keeps two node centres at least their combined radii apart, at a per-iteration
// cost the plan deliberately avoided for the 5,000-node case — so it is scoped to graphs small
// enough that the cost is free in practice. It works in GRAPH units while sigma draws sizes in
// SCREEN pixels, so it only stops visual overlap together with buildGraph.ts's densityScale, which
// shrinks nodes as a view gets denser.
const ADJUST_SIZES_BELOW = 2_000;

/** Complete, because the worker receives them verbatim: nothing fills in the package defaults on the
 *  way (its supervisor did, and layout.ts no longer uses it), and a missing edgeWeightInfluence or
 *  barnesHutTheta is NaN inside iterate.js — NaN positions are nodes that vanish from the canvas. */
function settingsFor(graph: MasteryGraph): ForceAtlas2Settings {
  return {
    linLogMode: false,
    outboundAttractionDistribution: false,
    edgeWeightInfluence: 1,
    barnesHutTheta: 0.5,
    // Gephi's own heuristic (the package's inferSettings) turns this on for anything but a
    // tiny graph — it replaces gravity's normal 1/distance falloff with a CONSTANT pull toward the
    // centre (iterate.js: `factor = coefficient * mass * g`, which algebraically cancels
    // `coefficient` entirely, making the pull independent of scalingRatio). That constant pull is
    // what packed a 400-node fixture into one dense, gapless clump regardless of how far
    // scalingRatio was pushed up (tried well past what any reasonable tuning would use, with no
    // visible change) — strong gravity mode inherently favours a compact ball over the spread,
    // visibly-gapped hairball a browsable "whole vault" view needs. Left off, gravity keeps its
    // normal falloff and scalingRatio's usual job (repulsion strength / effective spread) works as
    // expected again.
    strongGravityMode: false,
    barnesHutOptimize: graph.order > LAYOUT.barnesHutAbove,
    slowDown: LAYOUT.slowDown,
    gravity: LAYOUT.gravity,
    scalingRatio: LAYOUT.scalingRatio,
    adjustSizes: graph.order < ADJUST_SIZES_BELOW,
  };
}

/** `frame` is the canvas and label metrics at settle time, which the component packing fits. */
export function createLayout(
  graph: MasteryGraph, opts: { reducedMotion?: boolean; frame?: () => LabelFrame | undefined } = {},
): LayoutController {
  const listeners = new Set<() => void>();
  // Once a worker construction has failed once, retrying it on every start() (e.g. every drag) would
  // just log the same failure repeatedly for no benefit — the failure is almost always permanent
  // (no WebWorker support, blocked Blob URLs), so we stick to the synchronous path from then on.
  let workerFailed = false;
  let reducedMotion = opts.reducedMotion === true;
  const useSyncFallback = () => workerFailed || reducedMotion;
  let running = false;
  let worker: Worker | null = null;
  let settings: ForceAtlas2Settings | null = null;
  // Matrix offset of each node for the current run — graphToByteArrays' forEachNode order.
  let offsets = new Map<string, number>();
  // Where the cursor holds each dragged node. Written into every request so the worker lays the rest
  // out around it, and over every result the graph takes so the node stays under the cursor.
  const pins = new Map<string, Point>();
  // Released since the last request: the worker still has them fixed until told otherwise.
  const unpinned = new Set<string>();
  // The worker iterates as fast as it can; the graph takes only the newest result, once per frame.
  // Every result is copied into one buffer per run (the worker's own is transferred straight back),
  // so a run allocates once rather than once per iteration.
  let scratch: Float32Array | null = null;
  let latest: Float32Array | null = null;
  let applyFrame: number | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let settleInterval: ReturnType<typeof setInterval> | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  let maxRunTimer: ReturnType<typeof setTimeout> | null = null;
  let prevSnapshot: Float64Array | null = null;
  let prevOrder = -1;
  let belowCount = 0;
  // Settling is judged on positions that actually LANDED, not on wall-clock windows. A check window
  // with nothing applied in it (a stalled frame, a background tab) says nothing about movement, but
  // used to count as "stopped moving" — two such windows froze a 5,000-node layout mid-spread about
  // a second in (graph-perf.e2e.ts, on roughly every other run). Results land through
  // graph.updateEachNodeAttributes (applyLatest), so that event is the count.
  let applied = 0;
  let appliedAtCheck = 0;
  const countApplied = () => { applied += 1; };
  graph.on('eachNodeAttributesUpdated', countApplied);

  function writePins(nodes: Float32Array): void {
    for (const [node, p] of pins) {
      const i = offsets.get(node);
      if (i === undefined) continue;
      nodes[i + NODE_X] = p.x;
      nodes[i + NODE_Y] = p.y;
      nodes[i + NODE_FIXED] = 1;
    }
    for (const node of unpinned) {
      const i = offsets.get(node);
      if (i !== undefined) nodes[i + NODE_FIXED] = 0;
    }
    unpinned.clear();
  }

  function applyLatest(): void {
    const m = latest;
    latest = null;
    if (!m || m.length !== graph.order * PPN) return;
    let i = 0;
    graph.updateEachNodeAttributes((node, attrs) => {
      const pin = pins.get(node);
      attrs.x = pin ? pin.x : m[i + NODE_X];
      attrs.y = pin ? pin.y : m[i + NODE_Y];
      i += PPN;
      return attrs;
    }, { attributes: ['x', 'y'] });
  }

  function onResult(from: Worker, event: MessageEvent<{ nodes: ArrayBuffer }>): void {
    if (from !== worker || !running || !settings) return;
    const nodes = new Float32Array(event.data.nodes);
    writePins(nodes);
    if (scratch === null || scratch.length !== nodes.length) scratch = new Float32Array(nodes.length);
    scratch.set(nodes);
    latest = scratch;
    if (applyFrame === null) {
      applyFrame = requestAnimationFrame(() => {
        applyFrame = null;
        applyLatest();
      });
    }
    from.postMessage({ settings, nodes: nodes.buffer }, [nodes.buffer]);
  }

  function endWorker(): void {
    worker?.terminate();
    worker = null;
    latest = null;
    if (applyFrame !== null) {
      cancelAnimationFrame(applyFrame);
      applyFrame = null;
    }
  }

  /** Starts a worker on the graph as it is now. False when no worker can be made at all. */
  function spawn(): boolean {
    let w: Worker;
    try {
      w = createWorker(workerFunction);
    } catch (err) {
      console.error('[graph] layout worker failed, laying out on the main thread:', err);
      workerFailed = true;
      return false;
    }
    settings = settingsFor(graph);
    scratch = null;
    const matrices = graphToByteArrays(graph, () => 1);
    offsets = new Map();
    let j = 0;
    graph.forEachNode((node) => { offsets.set(node, j); j += PPN; });
    writePins(matrices.nodes);
    worker = w;
    w.addEventListener('message', (event) => onResult(w, event as MessageEvent<{ nodes: ArrayBuffer }>));
    w.postMessage(
      { settings, nodes: matrices.nodes.buffer, edges: matrices.edges.buffer },
      [matrices.nodes.buffer, matrices.edges.buffer],
    );
    return true;
  }

  // The matrices are indexed by the node order at spawn time, so ANY change to the node or edge set
  // mid-run (a poll adding a page) makes them wrong. Coalesced: one sync can add thousands of edges.
  const onStructureChange = () => {
    if (!running || restartTimer !== null) return;
    latest = null;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!running) return;
      endWorker();
      if (!spawn()) runSync();
    }, 0);
  };
  const STRUCTURE_EVENTS = ['nodeAdded', 'nodeDropped', 'edgeAdded', 'edgeDropped', 'edgesCleared', 'cleared'] as const;
  for (const name of STRUCTURE_EVENTS) graph.on(name, onStructureChange);

  function clearReleaseTimer(): void {
    if (releaseTimer !== null) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }
  }

  function clearSettleWatch(): void {
    if (settleInterval !== null) {
      clearInterval(settleInterval);
      settleInterval = null;
    }
    prevSnapshot = null;
    prevOrder = -1;
    belowCount = 0;
  }

  function clearTimers(): void {
    clearReleaseTimer();
    clearSettleWatch();
    if (maxRunTimer !== null) {
      clearTimeout(maxRunTimer);
      maxRunTimer = null;
    }
    if (restartTimer !== null) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  }

  function stop(): void {
    clearTimers();
    // What the worker computed since the last frame is the layout's final word — keep it.
    if (running) applyLatest();
    endWorker();
    running = false;
  }

  function fireSettle(): void {
    stop();
    packComponents(graph, opts.frame?.());
    for (const cb of listeners) cb();
  }

  function beginSettleWatch(): void {
    prevSnapshot = snapshot(graph);
    prevOrder = graph.order;
    belowCount = 0;
    appliedAtCheck = applied;
    settleInterval = setInterval(() => {
      // The node count changed mid-layout (syncGraph added/removed nodes): the old snapshot no
      // longer lines up with forEachNode's order, so restart the baseline instead of comparing
      // apples to oranges and mistaking churn for settling.
      if (graph.order !== prevOrder) {
        prevOrder = graph.order;
        prevSnapshot = snapshot(graph);
        belowCount = 0;
        appliedAtCheck = applied;
        return;
      }
      // Nothing landed since the last check: no evidence either way. The baseline stays put, so
      // the next check measures across the whole gap.
      if (applied === appliedAtCheck) return;
      appliedAtCheck = applied;
      const displacement = prevSnapshot ? meanDisplacement(prevSnapshot, graph) : Infinity;
      prevSnapshot = snapshot(graph);
      // Scale-free: see LAYOUT.settleRelativeEpsilon's comment for why an absolute threshold
      // never fires at ForceAtlas2's coordinate scale. A degenerate bbox (0 or 1 node, or every
      // node still stacked on the same point) has no extent to divide by — fall back to the raw
      // displacement, which is 0 in that case and settles immediately, same as before.
      const diag = bboxDiagonal(graph);
      const relative = diag > 0 ? displacement / diag : displacement;
      if (relative < LAYOUT.settleRelativeEpsilon) {
        belowCount += 1;
        if (belowCount >= LAYOUT.settleChecks) fireSettle();
      } else {
        belowCount = 0;
      }
    }, LAYOUT.settleCheckMs);
  }

  function runSync(): void {
    forceAtlas2.assign(graph, { iterations: LAYOUT.syncIterations, settings: settingsFor(graph) });
    fireSettle();
  }

  function start(): void {
    if (running || graph.order === 0) return;
    if (useSyncFallback() || !spawn()) {
      runSync();
      return;
    }
    running = true;
    beginSettleWatch();
    // Safety valve: without this, a graph that never satisfies the relative-displacement check
    // (a genuinely non-converging layout, or a future settle-detection bug) runs the worker
    // forever, and every frame it runs re-processes every node in sigma.
    const cap = maxRunMsFor(graph.order);
    maxRunTimer = setTimeout(() => {
      maxRunTimer = null;
      console.warn(`[graph] layout hit its ${cap}ms run cap at ${graph.order} nodes without settling — stopping anyway`);
      fireSettle();
    }, cap);
  }

  function kill(): void {
    clearTimers();
    endWorker();
    running = false;
    listeners.clear();
    graph.removeListener('eachNodeAttributesUpdated', countApplied);
    for (const name of STRUCTURE_EVENTS) graph.removeListener(name, onStructureChange);
  }

  return {
    start,
    stop,
    kill,
    isRunning: () => running,
    // A poll can drop the node under a held pointer; the drag then has nothing left to move.
    pin(node, x, y) {
      if (!graph.hasNode(node)) return;
      pins.set(node, { x, y });
      unpinned.delete(node);
      graph.mergeNodeAttributes(node, { x, y, fixed: true });
      // A new grab within releaseRunMs of the last release must not be stopped by that release.
      clearReleaseTimer();
      if (!running && !useSyncFallback()) start();
    },
    release(node) {
      pins.delete(node);
      if (graph.hasNode(node)) {
        unpinned.add(node);
        graph.mergeNodeAttributes(node, { fixed: false });
      }
      if (!running) return;
      clearReleaseTimer();
      // A settle like any other, so the dragged positions are saved and the frame can refit.
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        fireSettle();
      }, LAYOUT.releaseRunMs);
    },
    onSettle(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setReducedMotion(reduced) {
      reducedMotion = reduced;
    },
  };
}
