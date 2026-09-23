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

export function createLayout(graph: MasteryGraph, opts: { reducedMotion?: boolean } = {}): LayoutController {
  const listeners = new Set<() => void>();
  // Once a worker construction has failed once, retrying it on every start() (e.g. every drag) would
  // just log the same failure repeatedly for no benefit — the failure is almost always permanent
  // (no WebWorker support, blocked Blob URLs), so we stick to the synchronous path from then on.
  let useSyncFallback = opts.reducedMotion === true;
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
    // Copied because `nodes` is transferred straight back to the worker below.
    latest = nodes.slice();
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
      useSyncFallback = true;
      return false;
    }
    settings = settingsFor(graph);
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
    stop();
    for (const cb of listeners) cb();
  }

  function start(): void {
    if (running || graph.order === 0) return;
    if (useSyncFallback || !spawn()) {
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
    pin(node, x, y) {
      pins.set(node, { x, y });
      unpinned.delete(node);
      graph.mergeNodeAttributes(node, { x, y, fixed: true });
      // A new grab within releaseRunMs of the last release must not be stopped by that release.
      clearReleaseTimer();
      if (!running && !useSyncFallback) start();
    },
    release(node) {
      pins.delete(node);
      unpinned.add(node);
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
