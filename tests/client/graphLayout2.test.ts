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
  LAYOUT, meanDisplacement, bboxDiagonal, snapshot, createLayout, maxRunMsFor,
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
      settleCheckMs: 250, settleRelativeEpsilon: 0.0015, settleChecks: 2,
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

describe('createLayout — settle detection is scale-free', () => {
  const originalWorker = (globalThis as unknown as { Worker?: unknown }).Worker;

  afterEach(() => {
    (globalThis as unknown as { Worker?: unknown }).Worker = originalWorker;
    vi.useRealTimers();
  });

  it('settles on relative displacement even when absolute displacement is large', () => {
    // At a bbox diagonal of ~100,000 graph units (ForceAtlas2's own scale at scalingRatio 8 on a
    // real graph — see LAYOUT.settleRelativeEpsilon's comment), a per-tick displacement of 0.2
    // units is settled (relative ~0.000002, under settleRelativeEpsilon 0.0015) even though 0.2 is
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
    // absolute epsilon but tiny relative to the graph's own scale.
    graph.mergeNodeAttributes('b', { x: 100_000.4, y: 0 });
    vi.advanceTimersByTime(LAYOUT.settleCheckMs);
    expect(onSettle).not.toHaveBeenCalled();

    graph.mergeNodeAttributes('b', { x: 100_000.8, y: 0 });
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
      graph.mergeNodeAttributes('b', { x: 10 + bump * 5, y: 0 });
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

  it('a null storage (unavailable) is a safe no-op', () => {
    expect(loadPositions(null)).toEqual(new Map());
    const graph = freshGraph();
    addNode(graph, 'a', 1, 1);
    expect(() => savePositions(graph, null)).not.toThrow();
  });
});
