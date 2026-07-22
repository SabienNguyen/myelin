// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import type { LaidOutNode, LaidOutEdge } from '../../src/client/lib/graphLayout.js';
import { panelBus } from '../../src/client/lib/panelBus.js';

// GraphPanel calls useThreadRuntime() unconditionally — stub it rather than standing up a real
// AssistantRuntimeProvider, matching tests/client/urlState.integration.test.tsx's approach.
vi.mock('@assistant-ui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return { ...actual, useThreadRuntime: () => ({ append: vi.fn() }) };
});

// Wraps the real `positionNodes` (the expensive sugiyama/dagre pass) in a spy, so contextual-mode
// perf tests below can assert what it was actually called with — real layout behavior is
// preserved (the wrapped function still runs), only call tracking is added.
vi.mock('../../src/client/lib/graphLayout.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/lib/graphLayout.js')>();
  return { ...actual, positionNodes: vi.fn(actual.positionNodes) };
});

const { GraphPanel, contextualSubgraph, CONTEXT_HOPS, CONTEXT_CAP, POLL_MS } =
  await import('../../src/client/components/GraphPanel.js');
const { positionNodes } = await import('../../src/client/lib/graphLayout.js');
const positionNodesSpy = positionNodes as unknown as Mock;

function node(slug: string, overrides: Partial<LaidOutNode> = {}): LaidOutNode {
  return {
    slug, title: slug, x: 0, y: 0, color: '#000', ringFraction: null, daysLeft: null,
    misconceptions: [], effective: 'unseen', ...overrides,
  };
}
function edge(src: string, dst: string, type: LaidOutEdge['type'] = 'prereq'): LaidOutEdge {
  return { src, dst, type };
}

describe('contextualSubgraph', () => {
  it('a seed with no edges returns just the lone node, zero hops of neighbors, not truncated', () => {
    const nodes = [node('solo')];
    const g = contextualSubgraph(nodes, [], 'solo');
    expect(g.seedSlug).toBe('solo');
    expect(g.seedInferred).toBe(false);
    expect(g.nodes.map((n) => n.slug)).toEqual(['solo']);
    expect(g.edges).toEqual([]);
    expect(g.truncated).toBe(false);
  });

  it('includes 1-hop neighbors regardless of which end of the edge the seed is on (undirected)', () => {
    // 'seed' is the DST of a prereq edge from 'child' — direction must not matter for reachability.
    const nodes = [node('seed'), node('child'), node('unrelated')];
    const edges = [edge('child', 'seed', 'prereq')];
    const g = contextualSubgraph(nodes, edges, 'seed');
    expect(g.nodes.map((n) => n.slug).sort()).toEqual(['child', 'seed']);
  });

  it('includes 2-hop neighbors reached through either a prereq or a deepens edge', () => {
    // chain: a - b(seed) - c - d, with the last hop a `deepens` edge instead of `prereq`.
    const nodes = ['a', 'b', 'c', 'd'].map((s) => node(s));
    const edges = [edge('b', 'a', 'prereq'), edge('c', 'b', 'prereq'), edge('d', 'c', 'deepens')];
    const g = contextualSubgraph(nodes, edges, 'b');
    expect(g.nodes.map((n) => n.slug).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(g.hops).toBe(CONTEXT_HOPS);
  });

  it('excludes nodes farther than 2 hops away', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map((s) => node(s));
    // a - b(seed) - c - d - e : d is 2 hops from b (via c), e is 3 hops — only e should drop.
    const edges = [edge('b', 'a'), edge('c', 'b'), edge('d', 'c'), edge('e', 'd')];
    const g = contextualSubgraph(nodes, edges, 'b');
    expect(g.nodes.map((n) => n.slug).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('excludes nodes in an entirely disconnected component', () => {
    const nodes = [node('seed'), node('friend'), node('island')];
    const edges = [edge('seed', 'friend')];
    const g = contextualSubgraph(nodes, edges, 'seed');
    expect(g.nodes.map((n) => n.slug).sort()).toEqual(['friend', 'seed']);
    expect(g.edges).toEqual([edge('seed', 'friend')]);
  });

  it('cap: 1-hop neighbors are kept in full even when they alone exceed the cap', () => {
    const nodes = [node('seed'), node('h1a'), node('h1b'), node('h1c')];
    const edges = [edge('seed', 'h1a'), edge('seed', 'h1b'), edge('seed', 'h1c')];
    const g = contextualSubgraph(nodes, edges, 'seed', 2); // cap smaller than the 1-hop count
    expect(g.nodes.map((n) => n.slug).sort()).toEqual(['h1a', 'h1b', 'h1c', 'seed']);
  });

  it('cap: fills remaining room from hop-2 nodes ranked by degree (in the full graph), highest first', () => {
    // seed -> mid -> {lowDeg (degree 1), highDeg (degree 3, via two extra links to filler nodes)}
    const nodes = ['seed', 'mid', 'lowDeg', 'highDeg', 'filler1', 'filler2'].map((s) => node(s));
    const edges = [
      edge('seed', 'mid'),
      edge('mid', 'lowDeg'),
      edge('mid', 'highDeg'),
      edge('highDeg', 'filler1'),
      edge('highDeg', 'filler2'),
    ];
    // hop1 = {mid} (1 node), hop2 = {lowDeg, highDeg} (filler1/filler2 are hop3, out of range).
    // {seed, mid} already costs 2 of a cap-3 budget, leaving room for exactly one hop-2 node —
    // must be the higher-degree one (highDeg, degree 3 via mid+filler1+filler2 vs lowDeg's 1).
    const g = contextualSubgraph(nodes, edges, 'seed', 3);
    expect(g.nodes.map((n) => n.slug).sort()).toEqual(['highDeg', 'mid', 'seed']);
    expect(g.truncated).toBe(true);
  });

  it('truncated is false when every reachable node fits under the cap', () => {
    const nodes = [node('seed'), node('a'), node('b')];
    const edges = [edge('seed', 'a'), edge('a', 'b')];
    const g = contextualSubgraph(nodes, edges, 'seed', CONTEXT_CAP);
    expect(g.truncated).toBe(false);
    expect(g.nodes).toHaveLength(3);
  });

  it('only includes edges whose both endpoints survived into the subgraph', () => {
    const nodes = ['seed', 'a', 'b', 'c'].map((s) => node(s));
    // b-c is an edge entirely outside the seed's 2-hop neighborhood (b/c are only reachable, if at
    // all, via a fourth hop) — must not leak into the returned edge list even though b and c
    // individually could coincidentally still appear (they don't here, but the check matters).
    const edges = [edge('seed', 'a'), edge('b', 'c')];
    const g = contextualSubgraph(nodes, edges, 'seed');
    expect(g.nodes.map((n) => n.slug).sort()).toEqual(['a', 'seed']);
    expect(g.edges).toEqual([edge('seed', 'a')]);
  });

  it('an explicit seed wins even when another node has a fresher decay signal', () => {
    const nodes = [
      node('chosen', { daysLeft: 1 }),
      node('fresher', { daysLeft: 40 }),
    ];
    const g = contextualSubgraph(nodes, [], 'chosen');
    expect(g.seedSlug).toBe('chosen');
    expect(g.seedInferred).toBe(false);
  });

  it('a requested seed slug that no longer exists in the graph falls back to decay inference', () => {
    const nodes = [
      node('a', { daysLeft: 5 }),
      node('b', { daysLeft: 20 }), // freshest — least time elapsed since last_reinforced
      node('c', { daysLeft: null }),
    ];
    const g = contextualSubgraph(nodes, [], 'deleted-page');
    expect(g.seedSlug).toBe('b');
    expect(g.seedInferred).toBe(true);
  });

  it('no requested seed at all falls back to the freshest decay-eligible node', () => {
    const nodes = [node('a', { daysLeft: 3 }), node('b', { daysLeft: 9 }), node('c')];
    const g = contextualSubgraph(nodes, [], null);
    expect(g.seedSlug).toBe('b');
    expect(g.seedInferred).toBe(true);
  });

  it('no seed and no decay data anywhere falls back to the whole graph, seedSlug null', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('a', 'b')];
    const g = contextualSubgraph(nodes, edges, null);
    expect(g.seedSlug).toBeNull();
    expect(g.seedInferred).toBe(false);
    expect(g.hops).toBe(0);
    expect(g.nodes).toBe(nodes); // unfiltered passthrough
    expect(g.edges).toBe(edges);
  });
});

describe('GraphPanel — contextual mode (component)', () => {
  // a - b(seed) - c - d, plus an unrelated isolated node so contextual vs whole-vault is visibly
  // distinguishable in the rendered SVG text labels.
  const graphNodes = [
    { slug: 'a', title: 'Topic A', prereqs: [], deepens: [], mastery: null },
    { slug: 'b', title: 'Topic B', prereqs: ['a'], deepens: [], mastery: null },
    { slug: 'c', title: 'Topic C', prereqs: ['b'], deepens: [], mastery: null },
    { slug: 'd', title: 'Topic D', prereqs: [], deepens: ['c'], mastery: null },
    { slug: 'e', title: 'Topic Isolated', prereqs: [], deepens: [], mastery: null },
  ];

  function stubFetch() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/graph') return { ok: true, json: async () => ({ nodes: graphNodes }) } as any;
      throw new Error(`unexpected fetch: ${url}`);
    }));
  }

  beforeEach(() => { stubFetch(); location.hash = ''; });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); location.hash = ''; });

  it('with no page open yet and no decay data, defaults to the whole-vault hint', async () => {
    render(<GraphPanel visible />);
    await screen.findByText(/open a page to focus the graph/i);
    expect(screen.getByText('Topic Isolated')).not.toBeNull();
  });

  it('re-seeds live off a panelBus openPage event while visible', async () => {
    render(<GraphPanel visible />);
    await screen.findByText(/open a page to focus the graph/i);

    act(() => { panelBus.openPage('b'); });

    await screen.findByText(/around Topic B · 2 hops/i);
    expect(screen.getByText('Topic A')).not.toBeNull();
    expect(screen.getByText('Topic D')).not.toBeNull();
    expect(screen.queryByText('Topic Isolated')).toBeNull(); // outside the 2-hop neighborhood
  });

  it('the This topic / Whole vault toggle switches scope without waiting for a new openPage', async () => {
    render(<GraphPanel visible />);
    await screen.findByText(/open a page to focus the graph/i);
    act(() => { panelBus.openPage('b'); });
    await screen.findByText(/around Topic B/i);
    expect(screen.queryByText('Topic Isolated')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Whole vault' }));
    expect(screen.getByText('Topic Isolated')).not.toBeNull();
    expect(screen.queryByText(/around Topic B/i)).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'This topic' }));
    await screen.findByText(/around Topic B/i);
    expect(screen.queryByText('Topic Isolated')).toBeNull();
  });

  it('seeds from a page already open in the URL at mount, before any panelBus event fires', async () => {
    location.hash = '#/t/default/page/c';
    render(<GraphPanel visible />);
    await screen.findByText(/around Topic C · 2 hops/i);
    expect(screen.getByText('Topic B')).not.toBeNull();
    expect(screen.getByText('Topic D')).not.toBeNull();
    expect(screen.queryByText('Topic Isolated')).toBeNull();
  });
});

describe('GraphPanel — loading state', () => {
  const graphNodes = [
    { slug: 'a', title: 'Topic A', prereqs: [], deepens: [], mastery: null },
  ];

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); location.hash = ''; vi.useRealTimers(); });

  it('shows a "laying out the graph…" placeholder — not the hint, not an empty canvas — until the first load+layout resolves, then hides it', async () => {
    let resolveFetch!: (v: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })));

    const { container } = render(<GraphPanel visible />);
    expect(screen.getByText(/laying out the graph/i)).not.toBeNull();
    expect(screen.queryByText(/open a page to focus the graph/i)).toBeNull();
    expect(container.querySelector('svg')).toBeNull();

    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({ nodes: graphNodes }) });
    });

    expect(screen.queryByText(/laying out the graph/i)).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    await screen.findByText(/open a page to focus the graph/i);
  });

  it('does not re-show the loading placeholder on subsequent poll refreshes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ nodes: graphNodes }) })));

    render(<GraphPanel visible />);
    // Flush the first load's promise chain (fetch -> .json() -> setMeta/setLoading).
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText(/laying out the graph/i)).toBeNull();
    expect(screen.getByText(/open a page to focus the graph/i)).not.toBeNull();

    // Fast-forward past a full poll interval — the interval's own `load()` call resolves via the
    // same fetch stub, but must not flip `loading` back to true.
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(screen.queryByText(/laying out the graph/i)).toBeNull();
    expect(screen.getByText(/open a page to focus the graph/i)).not.toBeNull();
  });
});

describe('GraphPanel — contextual-first perf (layout scoped to subgraph)', () => {
  // A seed with 50 one-hop neighbors (comfortably over CONTEXT_CAP, so hop-1 completeness alone
  // forces the subgraph past the cap) plus 100 entirely disconnected filler nodes, so the vault
  // (151 nodes) is unambiguously larger than both the cap and the resulting subgraph.
  const HOP1_COUNT = 50;
  const FILLER_COUNT = 100;
  const bigGraphNodes = [
    { slug: 'seed', title: 'Seed Topic', prereqs: [], deepens: [], mastery: null },
    ...Array.from({ length: HOP1_COUNT }, (_, i) => ({
      slug: `child${i}`, title: `Child ${i}`, prereqs: ['seed'], deepens: [], mastery: null,
    })),
    ...Array.from({ length: FILLER_COUNT }, (_, i) => ({
      slug: `isolated${i}`, title: `Isolated ${i}`, prereqs: [], deepens: [], mastery: null,
    })),
  ];

  beforeEach(() => {
    positionNodesSpy.mockClear();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/graph') return { ok: true, json: async () => ({ nodes: bigGraphNodes }) } as any;
      throw new Error(`unexpected fetch: ${url}`);
    }));
    location.hash = '#/t/default/page/seed';
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); location.hash = ''; });

  it('lays out only the contextual subgraph, never the whole (151-node) vault', async () => {
    const { container } = render(<GraphPanel visible />);
    await screen.findByText(/around Seed Topic/i);

    // Rendered scope: seed + its 50 hop-1 children, none of the 100 disconnected filler nodes.
    expect(container.querySelectorAll('.graph-node')).toHaveLength(HOP1_COUNT + 1);
    expect(screen.queryByText('Isolated 0')).toBeNull();

    // `positionNodes` (the expensive sugiyama/dagre pass) must only ever have been asked to
    // position the subgraph — never all 151 nodes of the full vault.
    const calledSizes = positionNodesSpy.mock.calls.map((args: unknown[]) => (args[0] as unknown[]).length);
    expect(calledSizes).toContain(HOP1_COUNT + 1);
    expect(calledSizes).not.toContain(bigGraphNodes.length);
  });
});
