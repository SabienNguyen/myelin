// graphology's package.json points "types" at ONE shared .d.ts for both its "import" and "require"
// conditions, so under this project's moduleResolution (NodeNext, no esModuleInterop — out of this
// task's scope to change) TS can't tell the declaration is really ESM and treats `export default
// class Graph` as a CJS-shaped namespace: `import Graph from 'graphology'` type-errors ("cannot use
// namespace as a type") and isn't constructable either. The named export `MultiDirectedGraph` (a
// directed, multi-edge graph — exactly `new Graph({ type: 'directed', multi: true })`'s runtime
// shape) sidesteps the same default-export path entirely and typechecks and constructs cleanly;
// aliasing it to `Graph` keeps every call site below matching the plan's literal contract text.
import { MultiDirectedGraph as Graph } from 'graphology';
import { radiusForDegree, type GraphNodeMeta } from '../lib/graphLayout.js';
import type { Subgraph } from '../components/GraphPanel.js';

export type MasteryGraph = Graph<NodeAttrs, EdgeAttrs>;

export interface Point { x: number; y: number }

export interface NodeAttrs {
  x: number; y: number; size: number; color: string; label: string;
  type: 'mastery';                 // sigma program key, see T3
  ringFraction: number | null;     // decay arc, 0..1
  slipped: boolean;
  misconceptions: string[];
  effective: GraphNodeMeta['effective'];
  daysLeft: number | null;
  degree: number;
  forceLabel: boolean;
  fixed?: boolean;                 // ForceAtlas2 skips fixed nodes (drag pin)
}

export interface EdgeAttrs { kind: 'prereq' | 'deepens'; color: string; size: number }

export interface GraphColors {
  prereq: string; deepens: string; muted: string; label: string; warn: string; bad: string; background: string;
  border: string;
}

// radiusForDegree(px) → sigma size. 0.5 made the decay-arc ring (drawn just outside the node disc,
// see nodeProgram.ts) only a few px wide on a small contextual graph — a review screenshot of a
// 2-3 node topic view found the ring essentially unreadable. Nudged up so the ring reads clearly
// at contextual scale; the larger-graph hairball this trades against (a 400-node whole vault) is
// addressed separately in layout.ts (adjustSizes) rather than by shrinking every node back down.
export const NODE_SIZE_SCALE = 0.7;
export const SEED_JITTER = 20;
const MIN_DENSITY_SCALE = 0.3;

/** Node-size multiplier for a view of `count` pages. sigma draws sizes in screen pixels, so at fit
 *  a node is as big beside 5,000 others as beside 20 — a 400-page whole vault drew as one
 *  overlapping clump. Full size up to `fullSizeUpTo`, then shrinking with the square root of the
 *  count (so total node area grows linearly, not quadratically), floored so a node stays visible
 *  and grabbable. Zooming in still enlarges nodes (sigma scales them by sqrt of the zoom). */
export function densityScale(count: number, fullSizeUpTo: number): number {
  if (count <= fullSizeUpTo) return 1;
  return Math.max(MIN_DENSITY_SCALE, Math.sqrt(fullSizeUpTo / count));
}

// jsdom (component + this file's own tests) has no styles.css loaded, so getComputedStyle returns
// '' for every custom property — these hex literals are what graphLayout.ts's masteryColors()
// already does for the same reason, kept in sync with src/client/styles.css's :root dark defaults.
const FALLBACK = {
  text: '#edeef2', textMuted: '#a5a9b6', border: '#3a3e4a', warn: '#e5c17e', bad: '#f09c95',
  bgPanel: '#17191f',
};

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Resolved from CSS tokens (--text-muted, --border, --text, --warn, --bad, --bg-panel) with
 *  hex fallbacks for jsdom, same pattern as graphLayout.ts's masteryColors. Edge colours carry
 *  alpha via rgba(): prereq = --text-muted @0.75, deepens = --text-muted @0.4, muted = --border @0.35.
 *  `border` is also exposed raw (no alpha) for the hover label box's 1px stroke. */
export function resolveGraphColors(): GraphColors {
  const textMuted = cssVar('--text-muted', FALLBACK.textMuted);
  const border = cssVar('--border', FALLBACK.border);
  return {
    prereq: withAlpha(textMuted, 0.75),
    deepens: withAlpha(textMuted, 0.4),
    muted: withAlpha(border, 0.35),
    label: cssVar('--text', FALLBACK.text),
    warn: cssVar('--warn', FALLBACK.warn),
    bad: cssVar('--bad', FALLBACK.bad),
    background: cssVar('--bg-panel', FALLBACK.bgPanel),
    border,
  };
}

/** '#rrggbb' → 'rgba(r, g, b, a)'. Throws on anything else (tokens are hex; a new format must be
 *  noticed, not silently drawn black). */
export function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) throw new Error(`withAlpha: expected a '#rrggbb' token, got ${JSON.stringify(hex)}`);
  const r = parseInt(match[1].slice(0, 2), 16);
  const g = parseInt(match[1].slice(2, 4), 16);
  const b = parseInt(match[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Where a node with no remembered position starts: the mean of its already-placed neighbours plus
 *  jitter in [-SEED_JITTER, SEED_JITTER]; with none placed, a uniform point in a disc of radius
 *  30 * sqrt(totalNodes). `rand` is injectable for tests (defaults Math.random). */
export function seedPosition(placedNeighbours: Point[], totalNodes: number, rand: () => number = Math.random): Point {
  if (placedNeighbours.length > 0) {
    const meanX = placedNeighbours.reduce((sum, p) => sum + p.x, 0) / placedNeighbours.length;
    const meanY = placedNeighbours.reduce((sum, p) => sum + p.y, 0) / placedNeighbours.length;
    return {
      x: meanX + (rand() * 2 - 1) * SEED_JITTER,
      y: meanY + (rand() * 2 - 1) * SEED_JITTER,
    };
  }
  // Uniform over the DISC's area (not just its radius) needs sqrt(rand()) — a bare `rand() *
  // radius` would bunch points near the centre, since area grows with r^2.
  const radius = 30 * Math.sqrt(Math.max(0, totalNodes));
  const angle = rand() * 2 * Math.PI;
  const r = radius * Math.sqrt(rand());
  return { x: r * Math.cos(angle), y: r * Math.sin(angle) };
}

type ForceLabels = boolean | ReadonlySet<string>;

function nodeAttrs(n: GraphNodeMeta, opts: { forceLabels: ForceLabels; sizeScale?: number }): Omit<NodeAttrs, 'x' | 'y'> {
  return {
    size: radiusForDegree(n.degree) * NODE_SIZE_SCALE * (opts.sizeScale ?? 1),
    color: n.color,
    label: n.title,
    type: 'mastery',
    ringFraction: n.ringFraction,
    slipped: n.slipped,
    misconceptions: n.misconceptions,
    effective: n.effective,
    daysLeft: n.daysLeft,
    degree: n.degree,
    forceLabel: typeof opts.forceLabels === 'boolean' ? opts.forceLabels : opts.forceLabels.has(n.slug),
  };
}

/** Makes `graph` match `sub` IN PLACE so the live layout keeps running: removes nodes not in `sub`,
 *  adds new ones (position from `remembered`, else seedPosition from neighbours placed so far in
 *  this pass or already in the graph), updates every surviving node's display attrs WITHOUT
 *  touching its x/y, and brings the edge set in line. Returns the slugs added and removed. */
export function syncGraph(
  graph: MasteryGraph, sub: Subgraph<GraphNodeMeta>, remembered: ReadonlyMap<string, Point>,
  opts: { forceLabels: ForceLabels; colors: GraphColors; sizeScale?: number; rand?: () => number },
): { added: string[]; removed: string[] } {
  const targetSlugs = new Set(sub.nodes.map((n) => n.slug));
  const removed: string[] = [];
  for (const slug of graph.nodes()) {
    if (!targetSlugs.has(slug)) {
      graph.dropNode(slug);
      removed.push(slug);
    }
  }

  // Adjacency within the incoming subgraph only — used to find an already-placed neighbour for a
  // brand-new node. Built once up front so "placed so far in this pass" can be checked cheaply as
  // each new node is added below.
  const neighboursOf = new Map<string, string[]>();
  for (const e of sub.edges) {
    if (!neighboursOf.has(e.src)) neighboursOf.set(e.src, []);
    if (!neighboursOf.has(e.dst)) neighboursOf.set(e.dst, []);
    neighboursOf.get(e.src)!.push(e.dst);
    neighboursOf.get(e.dst)!.push(e.src);
  }

  const added: string[] = [];
  for (const n of sub.nodes) {
    const attrs = nodeAttrs(n, opts);
    if (graph.hasNode(n.slug)) {
      graph.mergeNodeAttributes(n.slug, attrs);
      continue;
    }
    added.push(n.slug);
    const rememberedPoint = remembered.get(n.slug);
    let point: Point;
    if (rememberedPoint) {
      point = rememberedPoint;
    } else {
      const placedNeighbours: Point[] = (neighboursOf.get(n.slug) ?? [])
        .filter((slug) => graph.hasNode(slug))
        .map((slug) => ({ x: graph.getNodeAttribute(slug, 'x'), y: graph.getNodeAttribute(slug, 'y') }));
      point = seedPosition(placedNeighbours, sub.nodes.length, opts.rand);
    }
    graph.addNode(n.slug, { ...attrs, x: point.x, y: point.y });
  }

  // Diffed, not cleared and re-added: every 30s poll syncs a usually unchanged graph, and each
  // edge event makes sigma reindex and the ForceAtlas2 supervisor terminate and respawn its worker.
  const wanted = new Map(sub.edges.map((e) => [`${e.type}:${e.src}->${e.dst}`, e]));
  for (const key of graph.edges()) {
    if (!wanted.has(key)) graph.dropEdge(key);
  }
  for (const [key, e] of wanted) {
    const color = opts.colors[e.type];
    if (graph.hasEdge(key)) {
      // A same-membership poll re-syncs this edge every 30s with an unchanged palette — only write
      // when a scheme flip actually moved the colour, so an ordinary poll fires no attribute event.
      if (graph.getEdgeAttribute(key, 'color') !== color) graph.setEdgeAttribute(key, 'color', color);
      continue;
    }
    graph.addEdgeWithKey(key, e.src, e.dst, {
      kind: e.type,
      color,
      size: e.type === 'prereq' ? 1 : 0.8,
    });
  }

  return { added, removed };
}
