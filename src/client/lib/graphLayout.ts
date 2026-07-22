import dagre from 'dagre';
import { graph as dagGraph, sugiyama, type MutGraphNode } from 'd3-dag';
import { DECAY, type MasteryLevel } from '../../shared/loreweaver.js';

const COLORS: Record<MasteryLevel, string> = {
  unseen: '#9e9e9e', exposed: '#e0b040', practicing: '#5b8def', mastered: '#4caf7d',
};
const WINDOW: Partial<Record<MasteryLevel, number>> = {
  mastered: DECAY.masteredDays, practicing: DECAY.practicingDays,
};

// Node footprint + inter-node gaps, kept equivalent to the old dagre
// nodesep/ranksep so the diagram's overall density doesn't change.
const NODE_W = 120, NODE_H = 60, GAP_X = 40, GAP_Y = 70;

export interface LaidOutNode {
  slug: string;
  title: string;
  x: number;
  y: number;
  color: string;
  ringFraction: number | null;
  daysLeft: number | null;
  misconceptions: string[];
  effective: MasteryLevel;
}

export interface LaidOutEdge {
  src: string;
  dst: string;
  type: 'prereq' | 'deepens';
}

type Pos = { x: number; y: number };

/**
 * Everything about a node that's derivable in O(n) straight from the raw /api/graph payload —
 * color, decay ring, edges — none of which needs the comparatively expensive (O(n log n)+)
 * sugiyama/dagre position pass below. Splitting this out lets callers (GraphPanel) compute cheap
 * membership info (contextualSubgraph only needs `slug` + `daysLeft`, plus the edge list) for the
 * WHOLE vault, then run the expensive position pass only over the small subset that survives.
 *
 * `prereqs` is kept around (rather than expecting callers to reconstruct it from `LaidOutEdge[]`)
 * so `positionsSugiyama`/`positionsDagre` below can run completely unmodified on any subset of
 * these nodes: passing a filtered node list naturally restricts layout edges to prereqs whose
 * *other* endpoint also survived the filter (see the `bySlug.get(p)` guards below) — exactly what
 * a subgraph-only layout pass needs, with no extra bookkeeping.
 */
export interface GraphNodeMeta extends Omit<LaidOutNode, 'x' | 'y'> {
  prereqs: string[];
}

// d3-dag's sugiyama places roots (sources of layout edges) in the lowest layer
// (smallest y) and their descendants in progressively larger y. We lay edges
// out prereq -> dependent (the foundation is the source), then invert y so the
// rendered picture keeps the existing semantics: foundations sit BELOW what
// they support, goals float toward the top. This mirrors what the previous
// dagre rankdir:'BT' pass did, just achieved via an explicit flip instead of
// dagre's rank-direction flag.
function positionsSugiyama(nodes: GraphNodeMeta[]): Map<string, Pos> | null {
  try {
    const g = dagGraph<string, undefined>();
    const bySlug = new Map<string, MutGraphNode<string, undefined>>();
    for (const n of nodes) bySlug.set(n.slug, g.node(n.slug));
    for (const n of nodes) {
      for (const p of n.prereqs) {
        const from = bySlug.get(p);
        const to = bySlug.get(n.slug);
        if (from && to) g.link(from, to); // layout edge: prereq -> dependent
      }
    }
    // Loreweaver's data model shouldn't produce cycles, but if it ever does,
    // sugiyama can't layer it — bail to the dagre fallback rather than throw.
    if (!g.acyclic()) return null;

    const layout = sugiyama().nodeSize([NODE_W, NODE_H] as const).gap([GAP_X, GAP_Y]);
    const { height } = layout(g);

    const pos = new Map<string, Pos>();
    for (const node of g.nodes()) pos.set(node.data, { x: node.x, y: height - node.y });
    return pos;
  } catch {
    // d3-dag graphs must be connectable this way, but guard against any
    // unexpected library error so a bad dataset degrades gracefully instead
    // of blanking the whole panel.
    return null;
  }
}

// Fallback layout kept from the pre-T29 implementation. Used only when the
// sugiyama pass can't run (cycles, or an unexpected d3-dag failure).
function positionsDagre(nodes: GraphNodeMeta[]): Map<string, Pos> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'BT', nodesep: GAP_X, ranksep: GAP_Y });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.slug, { width: NODE_W, height: NODE_H });
  for (const n of nodes) for (const p of n.prereqs) if (g.hasNode(p)) g.setEdge(p, n.slug);
  dagre.layout(g);
  const pos = new Map<string, Pos>();
  for (const n of nodes) {
    const p = g.node(n.slug);
    pos.set(n.slug, { x: p.x, y: p.y });
  }
  return pos;
}

/**
 * Cheap (no layout algorithm) pass over the raw /api/graph payload: derives the prereq/deepens
 * edge list and per-node decay metadata (color, ring, daysLeft). Safe to run over the whole vault
 * on every poll — the expensive part of the old `layoutGraph` is entirely in `positionNodes` below.
 */
export function graphMeta(nodes: any[], now: Date): { nodes: GraphNodeMeta[]; edges: LaidOutEdge[] } {
  const slugs = new Set(nodes.map((n) => n.slug));
  const edges: LaidOutEdge[] = [];
  for (const n of nodes) {
    for (const p of n.prereqs) if (slugs.has(p)) edges.push({ src: n.slug, dst: p, type: 'prereq' });
    for (const d of n.deepens) if (slugs.has(d)) edges.push({ src: n.slug, dst: d, type: 'deepens' });
  }

  const metaNodes: GraphNodeMeta[] = nodes.map((n) => {
    const effective: MasteryLevel = n.mastery?.effective ?? 'unseen';
    const window = WINDOW[effective];
    let daysLeft: number | null = null, ringFraction: number | null = null;
    if (window && n.mastery?.last_reinforced) {
      const elapsed = Math.floor((now.getTime() - new Date(n.mastery.last_reinforced).getTime()) / 86_400_000);
      daysLeft = Math.max(0, window - elapsed);
      ringFraction = daysLeft / window;
    }
    return {
      slug: n.slug, title: n.title, prereqs: n.prereqs ?? [],
      color: COLORS[effective], effective, daysLeft, ringFraction,
      misconceptions: n.mastery?.misconceptions ?? [],
    };
  });

  return { nodes: metaNodes, edges };
}

/**
 * Runs the (comparatively expensive) sugiyama/dagre position pass over exactly the nodes given —
 * callers control the cost by controlling how many nodes they pass in (e.g. a contextual subgraph
 * vs. the whole vault).
 */
export function positionNodes(nodes: GraphNodeMeta[]): LaidOutNode[] {
  const positions = positionsSugiyama(nodes) ?? positionsDagre(nodes);
  return nodes.map((n) => {
    const pos = positions.get(n.slug) ?? { x: 0, y: 0 };
    const { prereqs: _prereqs, ...rest } = n;
    return { ...rest, x: pos.x, y: pos.y };
  });
}

export function layoutGraph(nodes: any[], now: Date): { nodes: LaidOutNode[]; edges: LaidOutEdge[] } {
  const { nodes: meta, edges } = graphMeta(nodes, now);
  return { nodes: positionNodes(meta), edges };
}
