import { describe, it, expect } from 'vitest';
// See buildGraph.ts's comment on this same import for why MultiDirectedGraph (aliased) rather than
// the default export.
import { MultiDirectedGraph as Graph } from 'graphology';
import type { GraphNodeMeta } from '../../src/client/lib/graphLayout.js';
import type { Subgraph } from '../../src/client/components/GraphPanel.js';
import {
  type MasteryGraph, type GraphColors, type Point,
  withAlpha, seedPosition, syncGraph, SEED_JITTER,
} from '../../src/client/graph/buildGraph.js';
import { focusNeighbourhood, nodeReducer, edgeReducer } from '../../src/client/graph/highlight.js';

function node(slug: string, overrides: Partial<GraphNodeMeta> = {}): GraphNodeMeta {
  return {
    slug, title: slug, color: '#123456', ringFraction: null, daysLeft: null, slipped: false,
    misconceptions: [], effective: 'unseen', degree: 0, ...overrides,
  };
}

function sub(nodes: GraphNodeMeta[], edges: Subgraph['edges'] = []): Subgraph<GraphNodeMeta> {
  return { nodes, edges, seedSlug: null, seedInferred: false, hops: 0, truncated: false };
}

const COLORS: GraphColors = {
  prereq: 'rgba(1, 2, 3, 0.75)', deepens: 'rgba(1, 2, 3, 0.4)', muted: 'rgba(4, 5, 6, 0.35)',
  label: '#edeef2', warn: '#e5c17e', bad: '#f09c95', background: '#17191f',
};

function freshGraph(): MasteryGraph {
  return new Graph();
}

describe('withAlpha', () => {
  it('converts a hex token to rgba with the given alpha', () => {
    expect(withAlpha('#112233', 0.5)).toBe('rgba(17, 34, 51, 0.5)');
  });

  it('throws on anything that is not #rrggbb, instead of silently drawing black', () => {
    expect(() => withAlpha('red', 0.5)).toThrow();
    expect(() => withAlpha('#123', 0.5)).toThrow();
    expect(() => withAlpha('rgba(1,2,3,1)', 0.5)).toThrow();
  });
});

describe('seedPosition', () => {
  it('with placed neighbours and rand always at the midpoint, lands exactly on their mean', () => {
    const p = seedPosition([{ x: 10, y: 20 }, { x: 30, y: 40 }], 10, () => 0.5);
    expect(p).toEqual({ x: 20, y: 30 });
  });

  it('jitters within [-SEED_JITTER, SEED_JITTER] of the mean at the rand extremes', () => {
    const mean = { x: 20, y: 30 };
    const low = seedPosition([{ x: 10, y: 20 }, { x: 30, y: 40 }], 10, () => 0);
    const high = seedPosition([{ x: 10, y: 20 }, { x: 30, y: 40 }], 10, () => 1);
    expect(low).toEqual({ x: mean.x - SEED_JITTER, y: mean.y - SEED_JITTER });
    expect(high).toEqual({ x: mean.x + SEED_JITTER, y: mean.y + SEED_JITTER });
  });

  it('with no placed neighbours, lands inside a disc of radius 30*sqrt(totalNodes)', () => {
    const totalNodes = 9;
    const radius = 30 * Math.sqrt(totalNodes);
    // angle = 0 (first rand call), r = radius * sqrt(1) = radius (second rand call) — the outer
    // edge of the disc, exercising the boundary rather than just "somewhere near the middle".
    const seq = [0, 1];
    let i = 0;
    const rand = () => seq[i++];
    const p = seedPosition([], totalNodes, rand);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(radius, 5);
  });

  it('never lands outside the disc, across a spread of rand values', () => {
    const totalNodes = 4;
    const radius = 30 * Math.sqrt(totalNodes);
    for (const [a, r] of [[0, 0], [0.25, 0.5], [0.5, 1], [0.9, 0.1]]) {
      const seq = [a, r];
      let i = 0;
      const p = seedPosition([], totalNodes, () => seq[i++]);
      expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(radius + 1e-9);
    }
  });
});

describe('syncGraph', () => {
  it('adds nodes newly present in sub and removes nodes no longer present', () => {
    const graph = freshGraph();
    const first = syncGraph(graph, sub([node('a'), node('b')]), new Map(), { forceLabels: false, colors: COLORS });
    expect(first.added.sort()).toEqual(['a', 'b']);
    expect(first.removed).toEqual([]);
    expect(graph.nodes().sort()).toEqual(['a', 'b']);

    const second = syncGraph(graph, sub([node('b'), node('c')]), new Map(), { forceLabels: false, colors: COLORS });
    expect(second.added).toEqual(['c']);
    expect(second.removed).toEqual(['a']);
    expect(graph.nodes().sort()).toEqual(['b', 'c']);
  });

  it('keeps a surviving node\'s x/y untouched across a second sync, even as its metadata changes', () => {
    const graph = freshGraph();
    syncGraph(graph, sub([node('a')]), new Map(), { forceLabels: false, colors: COLORS, rand: () => 0.5 });
    graph.setNodeAttribute('a', 'x', 123);
    graph.setNodeAttribute('a', 'y', 456);

    syncGraph(graph, sub([node('a', { color: '#abcdef', degree: 5 })]), new Map(), { forceLabels: false, colors: COLORS });

    expect(graph.getNodeAttribute('a', 'x')).toBe(123);
    expect(graph.getNodeAttribute('a', 'y')).toBe(456);
    expect(graph.getNodeAttribute('a', 'color')).toBe('#abcdef');
    expect(graph.getNodeAttribute('a', 'degree')).toBe(5);
  });

  it('places a brand-new node at its remembered position when one exists', () => {
    const graph = freshGraph();
    const remembered = new Map<string, Point>([['a', { x: 77, y: -3 }]]);
    syncGraph(graph, sub([node('a')]), remembered, { forceLabels: false, colors: COLORS });
    expect(graph.getNodeAttribute('a', 'x')).toBe(77);
    expect(graph.getNodeAttribute('a', 'y')).toBe(-3);
  });

  it('seeds a new node near its already-placed neighbour when nothing is remembered', () => {
    const graph = freshGraph();
    syncGraph(graph, sub([node('hub')]), new Map(), { forceLabels: false, colors: COLORS });
    graph.setNodeAttribute('hub', 'x', 100);
    graph.setNodeAttribute('hub', 'y', 100);

    syncGraph(
      graph,
      sub([node('hub'), node('leaf')], [{ src: 'leaf', dst: 'hub', type: 'prereq' }]),
      new Map(),
      { forceLabels: false, colors: COLORS, rand: () => 0.5 }, // rand 0.5 -> zero jitter
    );

    expect(graph.getNodeAttribute('leaf', 'x')).toBe(100);
    expect(graph.getNodeAttribute('leaf', 'y')).toBe(100);
  });

  it('propagates forceLabels to every node', () => {
    const graph = freshGraph();
    syncGraph(graph, sub([node('a'), node('b')]), new Map(), { forceLabels: true, colors: COLORS });
    expect(graph.getNodeAttribute('a', 'forceLabel')).toBe(true);
    expect(graph.getNodeAttribute('b', 'forceLabel')).toBe(true);

    syncGraph(graph, sub([node('a'), node('b')]), new Map(), { forceLabels: false, colors: COLORS });
    expect(graph.getNodeAttribute('a', 'forceLabel')).toBe(false);
    expect(graph.getNodeAttribute('b', 'forceLabel')).toBe(false);
  });

  it('replaces the edge set wholesale, including dropping edges no longer present', () => {
    const graph = freshGraph();
    syncGraph(
      graph, sub([node('a'), node('b')], [{ src: 'a', dst: 'b', type: 'prereq' }]),
      new Map(), { forceLabels: false, colors: COLORS },
    );
    expect(graph.edges()).toEqual(['prereq:a->b']);

    syncGraph(
      graph, sub([node('a'), node('b')], [{ src: 'a', dst: 'b', type: 'deepens' }]),
      new Map(), { forceLabels: false, colors: COLORS },
    );
    expect(graph.edges()).toEqual(['deepens:a->b']);
    expect(graph.getEdgeAttribute('deepens:a->b', 'size')).toBe(0.8);
  });

  it('does not throw when the same pair of nodes carries both a prereq and a deepens edge', () => {
    const graph = freshGraph();
    const result = syncGraph(
      graph,
      sub([node('a'), node('b')], [
        { src: 'a', dst: 'b', type: 'prereq' },
        { src: 'a', dst: 'b', type: 'deepens' },
      ]),
      new Map(), { forceLabels: false, colors: COLORS },
    );
    expect(result.added.sort()).toEqual(['a', 'b']);
    expect(graph.edges().sort()).toEqual(['deepens:a->b', 'prereq:a->b']);
  });
});

describe('focusNeighbourhood', () => {
  function graphWithEdges(): MasteryGraph {
    const graph = freshGraph();
    syncGraph(
      graph,
      sub([node('a'), node('b'), node('c'), node('d')], [
        { src: 'a', dst: 'b', type: 'prereq' },
        { src: 'c', dst: 'a', type: 'deepens' },
      ]),
      new Map(), { forceLabels: false, colors: COLORS },
    );
    return graph;
  }

  it('returns null when nothing is focused', () => {
    expect(focusNeighbourhood(graphWithEdges(), null)).toBeNull();
  });

  it('returns null when the focused node is not (or no longer) in the graph', () => {
    expect(focusNeighbourhood(graphWithEdges(), 'ghost')).toBeNull();
  });

  it('returns the focus plus its neighbours in either edge direction, excluding unrelated nodes', () => {
    const set = focusNeighbourhood(graphWithEdges(), 'a');
    expect(set).toEqual(new Set(['a', 'b', 'c']));
  });
});

describe('nodeReducer', () => {
  it('passes data through unchanged when nothing is focused', () => {
    const reduce = nodeReducer(null, null, 'rgba(0,0,0,0.35)');
    const data = { color: '#fff', label: 'x' };
    expect(reduce('a', data)).toBe(data);
  });

  it('marks a node inside the focus set as highlighted with its label forced on', () => {
    const reduce = nodeReducer('a', new Set(['a', 'b']), 'rgba(0,0,0,0.35)');
    expect(reduce('a', { color: '#fff', label: 'A' })).toEqual({
      color: '#fff', label: 'A', zIndex: 1, forceLabel: true, highlighted: true,
    });
    expect(reduce('b', { color: '#fff', label: 'B' })).toEqual({
      color: '#fff', label: 'B', zIndex: 1, forceLabel: true, highlighted: false,
    });
  });

  it('mutes a node outside the focus set and clears its label', () => {
    const reduce = nodeReducer('a', new Set(['a']), 'rgba(0,0,0,0.35)');
    expect(reduce('z', { color: '#fff', label: 'Z' })).toEqual({
      color: 'rgba(0,0,0,0.35)', label: '', zIndex: 0,
    });
  });
});

describe('edgeReducer', () => {
  it('passes data through unchanged when nothing is focused', () => {
    const graph = freshGraph();
    graph.mergeEdgeWithKey('e1', 'a', 'b', {});
    const reduce = edgeReducer(graph, null, 'rgba(0,0,0,0.35)');
    const data = { size: 1 };
    expect(reduce('e1', data)).toBe(data);
  });

  it('boosts an edge whose endpoints are both in the focus set', () => {
    const graph = freshGraph();
    graph.mergeEdgeWithKey('e1', 'a', 'b', {});
    const reduce = edgeReducer(graph, new Set(['a', 'b']), 'rgba(0,0,0,0.35)');
    expect(reduce('e1', { size: 1, color: 'orig' })).toEqual({ size: 1.6, color: 'orig', zIndex: 1 });
  });

  it('mutes an edge with an endpoint outside the focus set', () => {
    const graph = freshGraph();
    graph.mergeEdgeWithKey('e1', 'a', 'b', {});
    const reduce = edgeReducer(graph, new Set(['a']), 'rgba(0,0,0,0.35)');
    expect(reduce('e1', { size: 1, color: 'orig' })).toEqual({ size: 1, color: 'rgba(0,0,0,0.35)', zIndex: 0 });
  });
});
