// graphology-layout-forceatlas2 (0.10.1) has no "type": "module" in its package.json, so under this
// project's NodeNext resolution it is treated as a CommonJS module. TS's CJS/ESM interop then folds
// this module's `export default` into "the default import IS the whole module namespace" (which
// mirrors Node's real runtime behaviour for a plain `module.exports = fn` package) — so the type of
// the default import loses `assign`/`inferSettings`, which exist only on the private, un-exported
// `IForceAtlas2Layout` interface attached to that default value in the library's own index.d.ts.
// Confirmed with `node -e "import('graphology-layout-forceatlas2').then(m => console.log(typeof
// m.default.assign))"` that the runtime value genuinely has both methods; the cast below only
// restores type information NodeNext's interop fails to expose, it does not paper over a real gap.
// The worker subpath needs an explicit `.js` extension — this package has no "exports" map, so
// NodeNext's extension-less subpath resolution (which works for the package's main entry via
// "main") does not apply to subpaths. The same CJS-interop fold hits its default export too (a
// `export default class FA2LayoutSupervisor {...}`), which is why the import below is unusable
// both as a type (`Cannot use namespace 'FA2LayoutSupervisor' as a type`) and as a constructor
// (`This expression is not constructable`) without the same restorative cast.
import forceAtlas2Import, { type ForceAtlas2Settings } from 'graphology-layout-forceatlas2';
import FA2LayoutSupervisorImport from 'graphology-layout-forceatlas2/worker.js';
import type { MasteryGraph } from './buildGraph.js';

interface ForceAtlas2Module {
  assign(graph: MasteryGraph, params: { iterations: number; settings: ForceAtlas2Settings }): void;
  inferSettings(graph: MasteryGraph): ForceAtlas2Settings;
}
const forceAtlas2 = forceAtlas2Import as unknown as ForceAtlas2Module;

interface FA2LayoutInstance {
  isRunning(): boolean;
  start(): void;
  stop(): void;
  kill(): void;
}
interface FA2LayoutConstructor {
  new (graph: MasteryGraph, params?: { settings?: ForceAtlas2Settings }): FA2LayoutInstance;
}
const FA2LayoutSupervisor = FA2LayoutSupervisorImport as unknown as FA2LayoutConstructor;

// FA2LayoutSupervisor's own message loop (worker.js's handleMessage, confirmed by reading
// node_modules/graphology-layout-forceatlas2/worker.js at the pinned 0.10.1) re-requests the next
// iteration the INSTANT the previous one's result arrives, with no pacing at all — worker.js's
// webworker.js does exactly one iterate() per message, so the round trip is only as slow as one
// iteration's compute plus a structured-clone postMessage. Measured against the 5,000-node /
// 12,000-edge fixture (graph-perf.e2e.ts), that loop ran far faster than the display can show
// anything: EVERY message calls graph.updateEachNodeAttributes (helpers.assignLayoutChanges),
// which fires graphology's `eachNodeAttributesUpdated` — and sigma's own handler for that event
// (bindGraphHandlers in node_modules/sigma) synchronously re-touches and re-uploads EVERY node's
// GPU buffer data on EVERY firing, not just the ones that actually get drawn (only the final WebGL
// draw call is rAF-debounced; the buffer-update loop is not). Left unthrottled, that starved the
// main thread badly enough that even OUR OWN 250ms settle-check interval was observed firing only
// a handful of times over 20+ seconds instead of ~90 — the settle/cap machinery in beginSettleWatch
// and start() below cannot do its job on a thread this saturated. `askForIterations` isn't part of
// the package's public API/.d.ts (see worker.d.ts), but it's a plain own-instance method (assigned
// in the constructor, not a closure), so replacing it after construction is a normal, narrow
// override — not a patch to the installed package — that every call site (both start()'s own
// initial request and handleMessage's repeated ones) picks up because they invoke it via `this.`.
// Pacing it to one request per animation frame caps the render-buffer-touching cost to what the
// display can show anyway, which is the same ceiling sigma's own scheduleRender already accepts.
function throttleIterationRequests(instance: FA2LayoutInstance): void {
  const target = instance as unknown as { askForIterations: (withEdges?: boolean) => void };
  const original = target.askForIterations.bind(target);
  let scheduled = false;
  target.askForIterations = (withEdges?: boolean) => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      original(withEdges);
    });
  };
}

export const LAYOUT = {
  barnesHutAbove: 500, slowDown: 6, gravity: 0.6, scalingRatio: 8,
  // Diagnosed against a real 5,000-node / 12,000-edge run (graph-perf.e2e.ts): ForceAtlas2 with
  // scalingRatio 8 operates at a coordinate scale where the bbox diagonal is in the hundreds to
  // low thousands of graph units, and the mean per-node displacement between 250ms settle checks
  // was measured at 50-300+ units WHILE the layout was still visibly spreading out — an absolute
  // epsilon of 0.15 (the old value) is three orders of magnitude below that scale and is never
  // reached while the graph is still moving at all; only a threshold relative to the graph's own
  // extent is scale-free across a 2-node contextual view and a 5,000-node whole vault alike.
  settleCheckMs: 250, settleRelativeEpsilon: 0.0015, settleChecks: 2,
  releaseRunMs: 1500, syncIterations: 150,
  // Hard ceiling on how long the worker is allowed to run before we stop it and treat it as
  // settled regardless — see maxRunMsFor. Without this, a graph whose layout never converges
  // (a dense hairball still slowly drifting, or a genuine settle-detection bug) runs the FA2
  // worker forever, and every worker message forces sigma to walk and re-upload every node's GPU
  // buffer (see GraphPanel.tsx's WebGL settings comment) — that is what starved panning in the
  // measured run (panning p50 137ms against a 20ms target) far more than panning itself costs.
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

// A whole-vault screenshot at ~400 nodes (well under barnesHutAbove) showed a hairball: nodes
// overlapping heavily rather than separated by visible gaps. adjustSizes (FA2's own anti-overlap
// term, which factors node radius into repulsion) stops two node CENTRES landing closer than their
// combined on-screen radii, at a real per-iteration cost the plan deliberately avoided for the
// 5,000-node case — so it is scoped to graphs small enough that the extra cost is free in practice,
// well below barnesHutAbove where the O(n²) term it adds would compound with Barnes-Hut's own
// overhead. adjustSizes alone was not enough, though: sigma's default itemSizesReference ('screen')
// renders every node at close to the same PIXEL size regardless of zoom (only sqrt(cameraRatio)-
// scaled), while adjustSizes' gap is a GRAPH-space quantity — at the zoom a few hundred nodes need
// to fit the frame, that gap shrinks to a few screen pixels even though the constant-pixel circles
// stay full size, so they visually overlapped anyway. A much larger scalingRatio for this same
// graph-size band pushes the GRAPH-space equilibrium spacing well past what any reasonable zoom
// compresses back down to overlapping — confirmed by screenshot at 400 nodes, not by formula.
const ADJUST_SIZES_BELOW = 2_000;

function settingsFor(graph: MasteryGraph): ForceAtlas2Settings {
  return {
    ...forceAtlas2.inferSettings(graph),
    // inferSettings turns this on by design (Gephi's own heuristic favours it for anything but a
    // tiny graph) — it replaces gravity's normal 1/distance falloff with a CONSTANT pull toward the
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

export function createLayout(graph: MasteryGraph, opts: { reducedMotion?: boolean } = {}): LayoutController {
  const listeners = new Set<() => void>();
  // Once a worker construction has failed once, retrying it on every start() (e.g. every drag) would
  // just log the same failure repeatedly for no benefit — the failure is almost always permanent
  // (no WebWorker support, blocked Blob URLs), so we stick to the synchronous path from then on.
  let useSyncFallback = opts.reducedMotion === true;
  let supervisor: FA2LayoutInstance | null = null;
  let running = false;
  let settleInterval: ReturnType<typeof setInterval> | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  let maxRunTimer: ReturnType<typeof setTimeout> | null = null;
  let prevSnapshot: Float64Array | null = null;
  let prevOrder = -1;
  let belowCount = 0;

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

  function clearMaxRunTimer(): void {
    if (maxRunTimer !== null) {
      clearTimeout(maxRunTimer);
      maxRunTimer = null;
    }
  }

  function stop(): void {
    clearReleaseTimer();
    clearSettleWatch();
    clearMaxRunTimer();
    if (supervisor && running) supervisor.stop();
    running = false;
  }

  function fireSettle(): void {
    stop();
    for (const cb of listeners) cb();
  }

  function beginSettleWatch(): void {
    prevSnapshot = snapshot(graph);
    prevOrder = graph.order;
    belowCount = 0;
    settleInterval = setInterval(() => {
      // The node count changed mid-layout (syncGraph added/removed nodes): the old snapshot no
      // longer lines up with forEachNode's order, so restart the baseline instead of comparing
      // apples to oranges and mistaking churn for settling.
      if (graph.order !== prevOrder) {
        prevOrder = graph.order;
        prevSnapshot = snapshot(graph);
        belowCount = 0;
        return;
      }
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
    running = false;
    for (const cb of listeners) cb();
  }

  function start(): void {
    if (running) return;
    if (useSyncFallback) {
      runSync();
      return;
    }
    let instance: FA2LayoutInstance;
    try {
      instance = new FA2LayoutSupervisor(graph, { settings: settingsFor(graph) });
    } catch (err) {
      console.error('[graph] layout worker failed, laying out on the main thread:', err);
      useSyncFallback = true;
      runSync();
      return;
    }
    supervisor = instance;
    throttleIterationRequests(instance);
    supervisor.start();
    running = true;
    beginSettleWatch();
    // Safety valve: without this, a graph that never satisfies the relative-displacement check
    // (a genuinely non-converging layout, or a future settle-detection bug) runs the worker
    // forever. Every worker message forces sigma to re-touch every node (see GraphPanel.tsx's
    // WebGL settings comment on hideEdgesOnMove/hideLabelsOnMove), which is real, measured cost —
    // stopping unconditionally after a size-scaled ceiling bounds that cost even in the worst case.
    const cap = maxRunMsFor(graph.order);
    maxRunTimer = setTimeout(() => {
      maxRunTimer = null;
      console.warn(`[graph] layout hit its ${cap}ms run cap at ${graph.order} nodes without settling — stopping anyway`);
      fireSettle();
    }, cap);
  }

  function kill(): void {
    clearReleaseTimer();
    clearSettleWatch();
    clearMaxRunTimer();
    if (supervisor) supervisor.kill();
    supervisor = null;
    running = false;
    listeners.clear();
  }

  return {
    start,
    stop,
    kill,
    isRunning: () => running,
    pin(node, x, y) {
      graph.mergeNodeAttributes(node, { x, y, fixed: true });
      if (!running && !useSyncFallback) start();
    },
    release(node) {
      graph.mergeNodeAttributes(node, { fixed: false });
      if (!running) return;
      clearReleaseTimer();
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        stop();
      }, LAYOUT.releaseRunMs);
    },
    onSettle(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
