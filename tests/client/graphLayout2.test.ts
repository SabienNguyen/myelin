// @vitest-environment jsdom
// jsdom (not this file's node default — see environmentMatchGlobs in vitest.config.ts, which this
// per-file pragma overrides) so `window`/`URL.createObjectURL` exist for the "settle detection is
// scale-free" describe block below, which needs graphology-layout-forceatlas2/worker's own
// `helpers.createWorker` to reach `new Worker(...)` (and hit OUR stub) instead of throwing on a
// missing `window` before ever getting there. jsdom has no real `Worker` either, so the existing
// "worker construction failure" test's `expect(Worker).toBeUndefined()` still holds.
import { describe, it, expect, vi, afterEach } from 'vitest';
// See buildGraph.ts's comment on this same import for why MultiDirectedGraph (aliased) rather than
// the default export.
import { MultiDirectedGraph as Graph } from 'graphology';
import type { MasteryGraph, Point } from '../../src/client/graph/buildGraph.js';
import {
  LAYOUT, meanDisplacement, bboxDiagonal, snapshot, createLayout, maxRunMsFor, packComponents,
  labelledBBox, unitsPerPx, budgetedReach, type LabelFrame,
} from '../../src/client/graph/layout.js';
import {
  POSITIONS_KEY, MAX_REMEMBERED, loadPositions, savePositions,
} from '../../src/client/graph/positionStore.js';

function freshGraph(): MasteryGraph {
  return new Graph();
}

function addNode(graph: MasteryGraph, slug: string, x: number, y: number): void {
  graph.addNode(slug, {
    x, y, size: 5, color: '#123456', label: slug, type: 'mastery', ringFraction: null,
    slipped: false, misconceptions: [], effective: 'unseen', daysLeft: null, degree: 0,
    forceLabel: false,
  });
}

describe('snapshot / meanDisplacement', () => {
  it('snapshot captures x/y pairs in forEachNode order', () => {
    const graph = freshGraph();
    addNode(graph, 'a', 0, 0);
    addNode(graph, 'b', 10, -5);
    expect(Array.from(snapshot(graph))).toEqual([0, 0, 10, -5]);
  });

  it('meanDisplacement reports the average per-node distance moved since the snapshot', () => {
    const graph = freshGraph();
    addNode(graph, 'a', 0, 0);
    addNode(graph, 'b', 10, 0);
    const before = snapshot(graph);
    graph.mergeNodeAttributes('a', { x: 3, y: 4 }); // moved distance 5
    graph.mergeNodeAttributes('b', { x: 10, y: 0 }); // unmoved
    expect(meanDisplacement(before, graph)).toBeCloseTo(2.5);
  });

  it('is zero when nothing moved', () => {
    const graph = freshGraph();
    addNode(graph, 'a', 1, 1);
    addNode(graph, 'b', -1, -1);
    expect(meanDisplacement(snapshot(graph), graph)).toBe(0);
  });
});

describe('bboxDiagonal', () => {
  it('is the diagonal of the node bbox', () => {
    const graph = freshGraph();
    addNode(graph, 'a', 0, 0);
    addNode(graph, 'b', 3, 4);
    expect(bboxDiagonal(graph)).toBeCloseTo(5); // 3-4-5 triangle
  });

  it('is 0 for an empty graph or a single point', () => {
    expect(bboxDiagonal(freshGraph())).toBe(0);
    const one = freshGraph();
    addNode(one, 'a', 7, 7);
    expect(bboxDiagonal(one)).toBe(0);
  });
});

describe('createLayout — reducedMotion', () => {
  it('lays out synchronously without ever touching Worker, moves nodes, and fires onSettle', () => {
    expect((globalThis as unknown as { Worker?: unknown }).Worker).toBeUndefined();
    const graph = freshGraph();
    addNode(graph, 'a', 100, 0);
    addNode(graph, 'b', -100, 0);
    graph.addEdge('a', 'b', { kind: 'prereq', color: '#000', size: 1 });
    const before = snapshot(graph);

    const layout = createLayout(graph, { reducedMotion: true });
    const onSettle = vi.fn();
    layout.onSettle(onSettle);
    layout.start();

    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(meanDisplacement(before, graph)).toBeGreaterThan(0);
    expect(layout.isRunning()).toBe(false);
  });
});

describe('createLayout — worker construction failure', () => {
  const originalWorker = (globalThis as unknown as { Worker?: unknown }).Worker;

  afterEach(() => {
    (globalThis as unknown as { Worker?: unknown }).Worker = originalWorker;
    vi.restoreAllMocks();
  });

  it('falls back to a synchronous layout and logs with the [graph] prefix', () => {
    (globalThis as unknown as { Worker: unknown }).Worker = class {
      constructor() {
        throw new Error('workers are not available here');
      }
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const graph = freshGraph();
    addNode(graph, 'a', 100, 0);
    addNode(graph, 'b', -100, 0);
    graph.addEdge('a', 'b', { kind: 'prereq', color: '#000', size: 1 });
    const before = snapshot(graph);

    const layout = createLayout(graph);
    const onSettle = vi.fn();
    layout.onSettle(onSettle);
    layout.start();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[graph]'),
      expect.any(Error),
    );
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(meanDisplacement(before, graph)).toBeGreaterThan(0);
    expect(layout.isRunning()).toBe(false);
  });
});

describe('createLayout — pin/release/kill', () => {
  it('pin sets position and fixed; release clears fixed', () => {
    const graph = freshGraph();
    addNode(graph, 'a', 0, 0);
    addNode(graph, 'b', 5, 5);
    const layout = createLayout(graph, { reducedMotion: true });

    layout.pin('a', 42, 43);
    expect(graph.getNodeAttribute('a', 'fixed')).toBe(true);
    expect(graph.getNodeAttribute('a', 'x')).toBe(42);
    expect(graph.getNodeAttribute('a', 'y')).toBe(43);

    layout.release('a');
    expect(graph.getNodeAttribute('a', 'fixed')).toBe(false);

    expect(() => layout.kill()).not.toThrow();
  });

  it('onSettle returns an unsubscribe that stops future callbacks', () => {
    const graph = freshGraph();
    addNode(graph, 'a', 10, 0);
    addNode(graph, 'b', -10, 0);
    graph.addEdge('a', 'b', { kind: 'prereq', color: '#000', size: 1 });
    const layout = createLayout(graph, { reducedMotion: true });
    const cb = vi.fn();
    const unsubscribe = layout.onSettle(cb);
    unsubscribe();
    layout.start();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('LAYOUT constants', () => {
  it('exposes the exact tuned values', () => {
    expect(LAYOUT).toEqual({
      barnesHutAbove: 500, slowDown: 6, gravity: 0.6, scalingRatio: 8,
      settleCheckMs: 250, settleRelativeEpsilon: 0.01, settleChecks: 2,
      releaseRunMs: 1500, syncIterations: 150,
      maxRunMsCeiling: 12_000, maxRunMsFloor: 3_000, maxRunMsPerNode: 3,
    });
  });
});

describe('maxRunMsFor', () => {
  it('floors at maxRunMsFloor for small graphs', () => {
    expect(maxRunMsFor(0)).toBe(3_000);
    expect(maxRunMsFor(17)).toBe(3_000);
    expect(maxRunMsFor(999)).toBe(3_000);
  });

  it('scales linearly with node count between the floor and the ceiling', () => {
    expect(maxRunMsFor(1_000)).toBe(3_000);
    expect(maxRunMsFor(2_000)).toBe(6_000);
  });

  it('caps at maxRunMsCeiling for large graphs', () => {
    expect(maxRunMsFor(5_000)).toBe(12_000);
    expect(maxRunMsFor(50_000)).toBe(12_000);
  });
});

// Fakes graphology-layout-forceatlas2/worker's dependency on a real Worker constructor, so
// createLayout takes its normal (non-reducedMotion, non-sync-fallback) path under jsdom — which
// has no real Worker global — without ever needing the fake to actually run an FA2 iteration.
// These tests drive the graph's positions directly and assert on layout.ts's OWN settle-interval
// and run-cap logic, which is otherwise only ever exercised for real by graph-perf.e2e.ts in a
// real browser.
class FakeWorker {
  addEventListener(): void {}
  removeEventListener(): void {}
  postMessage(): void {}
  terminate(): void {}
}

/** One worker iteration's worth of movement, landed the way FA2's supervisor lands it
 *  (helpers.assignLayoutChanges → updateEachNodeAttributes) — which is what settle detection counts. */
function landIteration(graph: MasteryGraph, xs: Record<string, number>): void {
  graph.updateEachNodeAttributes((node, attrs) => (node in xs ? { ...attrs, x: xs[node] } : attrs));
}

describe('createLayout — settle detection is scale-free', () => {
  const originalWorker = (globalThis as unknown as { Worker?: unknown }).Worker;

  afterEach(() => {
    (globalThis as unknown as { Worker?: unknown }).Worker = originalWorker;
    vi.useRealTimers();
  });

  it('settles on relative displacement even when absolute displacement is large', () => {
    // At a bbox diagonal of ~100,000 graph units (ForceAtlas2's own scale at scalingRatio 8 on a
    // real graph — see LAYOUT.settleRelativeEpsilon's comment), a per-tick displacement of 0.2
    // units is settled (relative ~0.000002, far under settleRelativeEpsilon) even though 0.2 is
    // well above the OLD absolute epsilon (0.15) that this test would have failed to settle under.
    (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
    vi.useFakeTimers();

    const graph = freshGraph();
    addNode(graph, 'a', 0, 0);
    addNode(graph, 'b', 100_000, 0);
    graph.addEdge('a', 'b', { kind: 'prereq', color: '#000', size: 1 });

    const layout = createLayout(graph);
    const onSettle = vi.fn();
    layout.onSettle(onSettle);
    layout.start();
    expect(layout.isRunning()).toBe(true);

    // Two consecutive small nudges (settleChecks: 2), each comfortably bigger than the old 0.15
    // absolute epsilon but tiny relative to the graph's own scale. Landed through
    // updateEachNodeAttributes, as every real worker iteration is.
    landIteration(graph, { b: 100_000.4 });
    vi.advanceTimersByTime(LAYOUT.settleCheckMs);
    expect(onSettle).not.toHaveBeenCalled();

    landIteration(graph, { b: 100_000.8 });
    vi.advanceTimersByTime(LAYOUT.settleCheckMs);

    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(layout.isRunning()).toBe(false);
  });

  it('stops unconditionally after maxRunMsFor(order) when the layout never settles', () => {
    (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const graph = freshGraph();
    addNode(graph, 'a', 0, 0);
    addNode(graph, 'b', 10, 0);
    graph.addEdge('a', 'b', { kind: 'prereq', color: '#000', size: 1 });

    // Registered before layout.start() so it runs first on every shared 250ms tick: keeps pushing
    // 'b' further out every check, which keeps relative displacement well above
    // settleRelativeEpsilon for as long as this interval keeps running — the ONLY thing that
    // should be able to stop this layout is the run-time cap, not the ordinary settle check.
    let bump = 0;
    const mutator = setInterval(() => {
      bump += 1;
      landIteration(graph, { b: 10 + bump * 5 });
    }, LAYOUT.settleCheckMs);

    const layout = createLayout(graph);
    const onSettle = vi.fn();
    layout.onSettle(onSettle);
    layout.start();

    const cap = maxRunMsFor(graph.order);
    vi.advanceTimersByTime(cap - LAYOUT.settleCheckMs);
    expect(onSettle).not.toHaveBeenCalled(); // still short of the cap, and still moving too fast to settle on its own

    vi.advanceTimersByTime(LAYOUT.settleCheckMs * 2);
    clearInterval(mutator);

    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(layout.isRunning()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[graph]'));
    warnSpy.mockRestore();
  });
});

describe('createLayout — settle needs iterations to judge', () => {
  const originalWorker = (globalThis as unknown as { Worker?: unknown }).Worker;
  afterEach(() => {
    (globalThis as unknown as { Worker?: unknown }).Worker = originalWorker;
    vi.useRealTimers();
  });

  // Iterations are paced one per animation frame. A frame longer than settleCheckMs (software WebGL
  // at 5,000 nodes takes 300-500ms) left two checks in a row with nothing landed between them, which
  // read as "stopped moving" and froze the layout mid-spread about a second after it started.
  it('does not settle while no iteration has landed, however many checks pass', () => {
    (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const graph = freshGraph();
    addNode(graph, 'a', 0, 0);
    addNode(graph, 'b', 100, 0);
    const layout = createLayout(graph);
    const onSettle = vi.fn();
    layout.onSettle(onSettle);
    layout.start();

    vi.advanceTimersByTime(LAYOUT.settleCheckMs * 6);
    expect(onSettle).not.toHaveBeenCalled();
    expect(layout.isRunning()).toBe(true);

    // Iterations that barely move anything are what settling looks like.
    for (let i = 0; i < LAYOUT.settleChecks + 1; i++) {
      landIteration(graph, { b: 100 + (i + 1) * 0.001 });
      vi.advanceTimersByTime(LAYOUT.settleCheckMs);
    }
    expect(onSettle).toHaveBeenCalledTimes(1);
    layout.kill();
  });
});

// Records what the layout sends and lets a test answer as the worker would: one iteration per
// request, the node matrix back in `nodes`.
class ScriptedWorker {
  static live = new Set<ScriptedWorker>();
  posted: Array<{ settings: Record<string, unknown>; nodes: Float32Array; edges?: Float32Array }> = [];
  private listener: ((event: { data: { nodes: ArrayBuffer } }) => void) | null = null;
  constructor() { ScriptedWorker.live.add(this); }
  addEventListener(_type: string, fn: (event: { data: { nodes: ArrayBuffer } }) => void): void { this.listener = fn; }
  removeEventListener(): void {}
  postMessage(payload: { settings: Record<string, unknown>; nodes: ArrayBuffer; edges?: ArrayBuffer }): void {
    this.posted.push({
      settings: payload.settings,
      nodes: new Float32Array(payload.nodes.slice(0)),
      edges: payload.edges ? new Float32Array(payload.edges.slice(0)) : undefined,
    });
  }
  terminate(): void { ScriptedWorker.live.delete(this); }
  /** Reply to the latest request with `move` applied to its matrix (node offset → new x/y). */
  reply(move: (nodes: Float32Array) => void): void {
    const nodes = new Float32Array(this.posted.at(-1)!.nodes);
    move(nodes);
    this.listener!({ data: { nodes: nodes.buffer } });
  }
}
const PPN = 10;

describe('createLayout — the worker loop', () => {
  const originalWorker = (globalThis as unknown as { Worker?: unknown }).Worker;
  afterEach(() => {
    (globalThis as unknown as { Worker?: unknown }).Worker = originalWorker;
    ScriptedWorker.live.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  function setup() {
    (globalThis as unknown as { Worker: unknown }).Worker = ScriptedWorker;
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const graph = freshGraph();
    addNode(graph, 'a', 0, 0);
    addNode(graph, 'b', 10, 0);
    graph.addEdge('a', 'b', { kind: 'prereq', color: '#000', size: 1 });
    const layout = createLayout(graph);
    return { graph, layout, worker: () => [...ScriptedWorker.live].at(-1)! };
  }

  // The worker gets settings verbatim — nothing fills in defaults on the way. A missing
  // edgeWeightInfluence or barnesHutTheta is NaN inside iterate.js, and NaN positions are nodes that
  // silently vanish from the canvas (a 60-page graph drew 16).
  it('sends the worker every setting iterate.js reads', () => {
    const { layout, worker } = setup();
    layout.start();
    const { settings } = worker().posted[0];
    for (const key of ['linLogMode', 'outboundAttractionDistribution', 'adjustSizes', 'edgeWeightInfluence',
      'scalingRatio', 'strongGravityMode', 'gravity', 'slowDown', 'barnesHutOptimize', 'barnesHutTheta']) {
      expect(settings[key], key).toBeDefined();
    }
    layout.kill();
  });

  // Every drag after a settle and every membership change starts a run. A worker left behind by an
  // earlier run is a thread that never goes away.
  it('keeps exactly one worker alive across runs, and none once stopped or killed', () => {
    const { graph, layout } = setup();
    for (let run = 0; run < 3; run++) {
      layout.start();
      expect(ScriptedWorker.live.size).toBe(1);
      layout.stop();
      expect(ScriptedWorker.live.size).toBe(0);
    }
    layout.start();
    addNode(graph, 'c', 5, 5); // a structure change mid-run replaces the worker, never adds one
    vi.advanceTimersByTime(1);
    expect(ScriptedWorker.live.size).toBe(1);
    layout.kill();
    expect(ScriptedWorker.live.size).toBe(0);
  });

  // The old supervisor owned the matrix: a node dragged mid-run snapped back to where the drag began
  // on every result, and its neighbours never followed the cursor.
  it('a node dragged mid-run is where the cursor is, fixed, in the next request and on the graph', () => {
    const { graph, layout, worker } = setup();
    layout.start();
    layout.pin('b', 42, 43);
    worker().reply((m) => { m[PPN] = 99; m[PPN + 1] = 99; }); // the worker moved b
    const next = worker().posted.at(-1)!.nodes;
    expect([next[PPN], next[PPN + 1], next[PPN + 9]]).toEqual([42, 43, 1]);
    vi.advanceTimersByTime(20); // one animation frame
    expect(graph.getNodeAttribute('b', 'x')).toBe(42);
    expect(graph.getNodeAttribute('b', 'y')).toBe(43);

    layout.release('b');
    worker().reply(() => {});
    expect(worker().posted.at(-1)!.nodes[PPN + 9]).toBe(0);
    layout.kill();
  });

  // sigma re-processes every node per update, so results must not each become one; but the worker
  // must not wait on frames either, or layout progress is tied to the frame rate.
  it('asks for the next iteration at once, and lands only the newest result per frame', () => {
    const { graph, layout, worker } = setup();
    const updates = vi.fn();
    graph.on('eachNodeAttributesUpdated', updates);
    layout.start();
    for (let k = 1; k <= 3; k++) worker().reply((m) => { m[0] = k; });
    expect(worker().posted).toHaveLength(4); // the first request plus one per result
    expect(updates).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(graph.getNodeAttribute('a', 'x')).toBe(3);
    layout.kill();
  });

  it('restarts on a structure change with matrices for the new node set', () => {
    const { graph, layout, worker } = setup();
    layout.start();
    const first = worker();
    addNode(graph, 'c', 5, 5);
    vi.advanceTimersByTime(1);
    expect(worker()).not.toBe(first);
    expect(worker().posted[0].nodes).toHaveLength(3 * PPN);
    expect(worker().posted[0].edges).toBeDefined();
    layout.kill();
  });

  // The release timer used to stop() without settling: no save, so a reload lost the drag.
  it('a release that runs out its time settles, like any other end of a run', () => {
    const { layout } = setup();
    const onSettle = vi.fn();
    layout.onSettle(onSettle);
    layout.pin('a', 1, 1);
    layout.release('a');
    vi.advanceTimersByTime(LAYOUT.releaseRunMs - 1);
    expect(onSettle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(layout.isRunning()).toBe(false);
    layout.kill();
  });

  // A poll can drop the node under a held pointer; the next move and the release used to throw.
  it('pin and release of a node that left the graph do nothing', () => {
    const { graph, layout } = setup();
    layout.pin('b', 1, 1);
    graph.dropNode('b');
    expect(() => layout.pin('b', 2, 2)).not.toThrow();
    expect(() => layout.release('b')).not.toThrow();
    expect(graph.hasNode('b')).toBe(false);
    layout.kill();
  });

  it('lays out on the main thread once reduced motion is turned on mid-session', () => {
    const { layout } = setup();
    const onSettle = vi.fn();
    layout.onSettle(onSettle);
    layout.setReducedMotion(true);
    layout.start();
    expect(ScriptedWorker.live.size).toBe(0);
    expect(onSettle).toHaveBeenCalledTimes(1);
    layout.setReducedMotion(false);
    layout.start();
    expect(ScriptedWorker.live.size).toBe(1);
    layout.kill();
  });

  it('a new grab within releaseRunMs of a release keeps the layout running', () => {
    const { layout } = setup();
    layout.pin('a', 1, 1);
    layout.release('a');
    layout.pin('b', 2, 2);
    vi.advanceTimersByTime(LAYOUT.releaseRunMs + 1);
    expect(layout.isRunning()).toBe(true);
    layout.kill();
  });
});

describe('packComponents', () => {
  function twoSubjects(): MasteryGraph {
    const graph = freshGraph();
    // A three-page subject near the origin and a two-page one drifted far off to the lower left.
    addNode(graph, 'a1', 0, 0);
    addNode(graph, 'a2', 100, 0);
    addNode(graph, 'a3', 50, 80);
    graph.addEdge('a1', 'a2', { kind: 'prereq', color: '#000', size: 1 });
    graph.addEdge('a2', 'a3', { kind: 'prereq', color: '#000', size: 1 });
    addNode(graph, 'r1', -5000, -5000);
    addNode(graph, 'r2', -4960, -4990);
    graph.addEdge('r1', 'r2', { kind: 'deepens', color: '#000', size: 1 });
    return graph;
  }
  const at = (graph: MasteryGraph, n: string) => [graph.getNodeAttribute(n, 'x'), graph.getNodeAttribute(n, 'y')];

  it('brings a drifted subject next to the others, keeping each subject\'s own shape', () => {
    const graph = twoSubjects();
    const before = bboxDiagonal(graph);
    packComponents(graph);
    expect(bboxDiagonal(graph)).toBeLessThan(before / 10);
    const [a1x, a1y] = at(graph, 'a1');
    const [a3x, a3y] = at(graph, 'a3');
    expect([a3x - a1x, a3y - a1y]).toEqual([50, 80]);
    const [r1x, r1y] = at(graph, 'r1');
    const [r2x, r2y] = at(graph, 'r2');
    expect([r2x - r1x, r2y - r1y]).toEqual([40, 10]);
  });

  it('leaves a gap between subjects instead of overlapping them', () => {
    const graph = twoSubjects();
    packComponents(graph);
    const maxAX = Math.max(...['a1', 'a2', 'a3'].map((n) => graph.getNodeAttribute(n, 'x')));
    const maxAY = Math.max(...['a1', 'a2', 'a3'].map((n) => graph.getNodeAttribute(n, 'y')));
    const r1 = at(graph, 'r1');
    expect(r1[0] > maxAX || r1[1] > maxAY).toBe(true);
  });

  it('packs the same way on every settle', () => {
    const graph = twoSubjects();
    packComponents(graph);
    const once = snapshot(graph);
    packComponents(graph);
    expect(meanDisplacement(once, graph)).toBe(0);
  });

  it('leaves a single connected graph where it is', () => {
    const graph = freshGraph();
    addNode(graph, 'a', -300, 20);
    addNode(graph, 'b', 400, 90);
    graph.addEdge('a', 'b', { kind: 'prereq', color: '#000', size: 1 });
    const before = snapshot(graph);
    packComponents(graph);
    expect(meanDisplacement(before, graph)).toBe(0);
  });
});

describe('packComponents with forced labels', () => {
  const CHAR_PX = 7;
  // The graph panel at its desktop size, every label forced on and CHAR_PX wide per character.
  function frameFor(graph: MasteryGraph): LabelFrame {
    return {
      width: 460, height: 360, padding: 54, labelHeight: 14,
      labelReach: (n) => graph.getNodeAttribute(n, 'size') + 3 + graph.getNodeAttribute(n, 'label').length * CHAR_PX,
    };
  }

  /** Pairs whose label boxes intersect on screen once sigma fits labelledBBox. */
  function overlappingLabels(graph: MasteryGraph, frame: LabelFrame): string[] {
    const box = labelledBBox(graph, frame);
    const u = unitsPerPx(frame, box.x[1] - box.x[0], box.y[1] - box.y[0]);
    const rects = graph.nodes().map((n) => {
      const { x, y, size } = graph.getNodeAttributes(n);
      return { n, left: x / u - size, right: x / u + budgetedReach(frame, n), top: y / u - 7, bottom: y / u + 7 };
    });
    const out: string[] = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) out.push(`${a.n}/${b.n}`);
      }
    }
    return out;
  }

  it('keeps unlinked pages\' titles apart instead of lining them up under each other', () => {
    const graph = freshGraph();
    // Six single-page subjects scattered where ForceAtlas2 left them, and a five-page chain.
    for (let i = 0; i < 6; i++) addNode(graph, `single page ${i}`, i * 30, (i % 3) * 20);
    for (let i = 0; i < 5; i++) {
      addNode(graph, `chain ${i}`, 400 + i * 40, 400 + i * 40);
      if (i > 0) graph.addEdge(`chain ${i - 1}`, `chain ${i}`, { kind: 'prereq', color: '#000', size: 1 });
    }
    const frame = frameFor(graph);
    expect(overlappingLabels(graph, frame)).not.toEqual([]);
    packComponents(graph, frame);
    expect(overlappingLabels(graph, frame)).toEqual([]);
  });

  it('spreads a subject whose own pages sit closer than their titles', () => {
    const graph = freshGraph();
    // Side by side and nearly level: far enough apart as points, not as titles.
    addNode(graph, 'Retrieval Practice for Durable Learning', 0, 0);
    addNode(graph, 'Flow: immersive engagement and enabling conditions', 30, 4);
    addNode(graph, 'Rust Ownership and Moves', 600, 600);
    graph.addEdge('Retrieval Practice for Durable Learning', 'Flow: immersive engagement and enabling conditions',
      { kind: 'deepens', color: '#000', size: 1 });
    const frame = frameFor(graph);
    packComponents(graph, frame);
    expect(overlappingLabels(graph, frame)).toEqual([]);
  });

  it('unstacks a subject laid out nearly level, beside unlinked pages', () => {
    const graph = freshGraph();
    // The shape that zoomed out without end when the whole subject was scaled to part its closest
    // pair: a five-page chain 2 units of height apart per step.
    for (let i = 0; i < 5; i++) {
      addNode(graph, `Rust chapter ${i}`, i * 30, i * 2);
      if (i > 0) graph.addEdge(`Rust chapter ${i - 1}`, `Rust chapter ${i}`, { kind: 'prereq', color: '#000', size: 1 });
    }
    for (let i = 0; i < 5; i++) addNode(graph, `single page ${i}`, 500 + i * 30, 0);
    const frame = frameFor(graph);
    packComponents(graph, frame);
    expect(overlappingLabels(graph, frame)).toEqual([]);
  });

  it('falls back to packing by node centres when the titles cannot all fit', () => {
    const graph = freshGraph();
    for (let i = 0; i < 12; i++) addNode(graph, `a page whose title runs well past half the panel ${i}`, i * 30, 0);
    const plain = freshGraph();
    graph.forEachNode((n, a) => plain.addNode(n, { ...a }));
    packComponents(plain);
    const frame = frameFor(graph);
    packComponents(graph, frame);
    // Still framed the size a centres-only packing is, not zoomed out after an unreachable fit.
    expect(bboxDiagonal(graph)).toBeLessThan(2 * bboxDiagonal(plain));
  });

  it('still packs the same way on every settle', () => {
    const graph = freshGraph();
    for (let i = 0; i < 4; i++) addNode(graph, `page ${i}`, i * 5, i * 3);
    graph.addEdge('page 0', 'page 1', { kind: 'prereq', color: '#000', size: 1 });
    const frame = frameFor(graph);
    packComponents(graph, frame);
    const once = snapshot(graph);
    packComponents(graph, frame);
    expect(meanDisplacement(once, graph)).toBeLessThan(0.01 * bboxDiagonal(graph));
  });
});

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  } as Storage;
}

describe('positionStore', () => {
  it('round-trips positions saved from a graph', () => {
    const storage = fakeStorage();
    const graph = freshGraph();
    addNode(graph, 'a', 1.5, 2.5);
    addNode(graph, 'b', -3, 4);

    savePositions(graph, storage);
    const loaded = loadPositions(storage);

    expect(loaded.get('a')).toEqual({ x: 1.5, y: 2.5 });
    expect(loaded.get('b')).toEqual({ x: -3, y: 4 });
    expect(JSON.parse(storage.getItem(POSITIONS_KEY) as string)).toEqual({
      a: { x: 1.5, y: 2.5 }, b: { x: -3, y: 4 },
    });
  });

  it('merges over what is already stored, so the other scope\'s nodes survive', () => {
    const storage = fakeStorage({ [POSITIONS_KEY]: JSON.stringify({ other: { x: 9, y: 9 } }) });
    const graph = freshGraph();
    addNode(graph, 'a', 1, 1);

    savePositions(graph, storage);

    expect(JSON.parse(storage.getItem(POSITIONS_KEY) as string)).toEqual({
      other: { x: 9, y: 9 }, a: { x: 1, y: 1 },
    });
  });

  it('drops non-finite coordinates instead of persisting them', () => {
    const storage = fakeStorage();
    const graph = freshGraph();
    addNode(graph, 'a', NaN, 1);
    addNode(graph, 'b', 1, Infinity);
    addNode(graph, 'c', 2, 3);

    savePositions(graph, storage);

    expect(JSON.parse(storage.getItem(POSITIONS_KEY) as string)).toEqual({ c: { x: 2, y: 3 } });
  });

  it('caps remembered positions at MAX_REMEMBERED, keeping the newest write', () => {
    const many: Record<string, Point> = {};
    for (let i = 0; i < MAX_REMEMBERED; i++) many[`old${i}`] = { x: i, y: i };
    const storage = fakeStorage({ [POSITIONS_KEY]: JSON.stringify(many) });
    const graph = freshGraph();
    addNode(graph, 'new-node', 0, 0);

    savePositions(graph, storage);
    const stored = JSON.parse(storage.getItem(POSITIONS_KEY) as string) as Record<string, Point>;

    expect(Object.keys(stored)).toHaveLength(MAX_REMEMBERED);
    expect(stored['new-node']).toEqual({ x: 0, y: 0 });
    expect(stored.old0).toBeUndefined();
  });

  it('bad JSON warns and returns an empty map, without throwing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = fakeStorage({ [POSITIONS_KEY]: '{not json' });

    expect(loadPositions(storage)).toEqual(new Map());
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('the wrong shape (e.g. an array) warns and returns an empty map', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = fakeStorage({ [POSITIONS_KEY]: JSON.stringify([1, 2, 3]) });

    expect(loadPositions(storage)).toEqual(new Map());
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('a throwing storage degrades to an empty map on load and never throws on save', () => {
    const throwingStorage: Storage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('quota exceeded'); },
      removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(loadPositions(throwingStorage)).toEqual(new Map());

    const graph = freshGraph();
    addNode(graph, 'a', 1, 1);
    expect(() => savePositions(graph, throwingStorage)).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // Every settle used to parse and re-serialise the whole remembered map (up to 1.4 MB).
  it('reads the stored map once, then writes once per save', () => {
    const storage = fakeStorage({ [POSITIONS_KEY]: JSON.stringify({ other: { x: 9, y: 9 } }) });
    const getItem = vi.spyOn(storage, 'getItem');
    const setItem = vi.spyOn(storage, 'setItem');
    const graph = freshGraph();
    addNode(graph, 'a', 1, 1);
    loadPositions(storage);
    savePositions(graph, storage);
    graph.setNodeAttribute('a', 'x', 2);
    savePositions(graph, storage);
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(loadPositions(storage).get('a')).toEqual({ x: 2, y: 1 });
    expect(JSON.parse(storage.getItem(POSITIONS_KEY) as string).other).toEqual({ x: 9, y: 9 });
  });

  it('a null storage (unavailable) is a safe no-op', () => {
    expect(loadPositions(null)).toEqual(new Map());
    const graph = freshGraph();
    addNode(graph, 'a', 1, 1);
    expect(() => savePositions(graph, null)).not.toThrow();
  });
});
