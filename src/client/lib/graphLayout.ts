import { type MasteryLevel } from '../../shared/engram.js';

// Mastery colours live in styles.css :root as --mastery-* so they have dark-scheme counterparts and
// so GraphPanel's legend can render swatches with var() instead of re-literalling these values (it
// used to duplicate all four, free to drift). The graph itself draws into SVG/canvas from JS and
// needs resolved strings, so read the tokens once per layout rather than hardcoding them here.
// FALLBACKS matter: jsdom unit tests mount the component without styles.css, where
// getPropertyValue() returns '' — the literals below keep those tests meaningful.
const FALLBACK_COLORS: Record<MasteryLevel, string> = {
  unseen: '#9e9e9e', exposed: '#e0b040', practicing: '#5b8def', mastered: '#4caf7d',
};

function masteryColors(): Record<MasteryLevel, string> {
  if (typeof document === 'undefined') return FALLBACK_COLORS;
  const cs = getComputedStyle(document.documentElement);
  const pick = (level: MasteryLevel) =>
    cs.getPropertyValue(`--mastery-${level}`).trim() || FALLBACK_COLORS[level];
  return { unseen: pick('unseen'), exposed: pick('exposed'), practicing: pick('practicing'), mastered: pick('mastered') };
}
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
  /** Count of edges (prereq + deepens, either direction) touching this node in the WHOLE vault —
   * NOT scoped to whatever subgraph is currently displayed, so a node's radius (see
   * `radiusForDegree`) stays stable as the student pans between contextual and whole-vault views,
   * the same way Obsidian's node size doesn't jump around as its local-graph filter changes. */
  degree: number;
}

export interface LaidOutEdge {
  src: string;
  dst: string;
  type: 'prereq' | 'deepens';
}

/**
 * Everything about a node that's derivable in O(n) straight from the raw /api/graph payload —
 * color, decay ring, degree. Cheap enough to (re)compute for the whole vault on every poll; the
 * force simulation (GraphPanel.tsx) owns position (x/y) instead, since — unlike the old sugiyama
 * pass this replaced — position now lives in mutable, continuously-ticking simulation node objects
 * rather than being a pure function of the graph's structure.
 */
export interface GraphNodeMeta extends Omit<LaidOutNode, 'x' | 'y'> {}

/**
 * Node radius scaled by degree, Obsidian-style: a node with more prereq/deepens links reads as
 * more "central" and renders bigger. Square-root growth (rather than linear) keeps a handful of
 * heavily-linked hub nodes from dwarfing everything else at whole-vault scale — diminishing
 * returns per additional link, same shape as a force layout's own degree-vs-visual-weight curves
 * usually want. Pulled out as a pure function (no simulation involved) so it's unit-testable
 * without standing up a DOM or a d3-force tick loop.
 */
export const NODE_R_MIN = 9;
const NODE_R_DEGREE_SCALE = 3.4;
export function radiusForDegree(degree: number): number {
  return NODE_R_MIN + NODE_R_DEGREE_SCALE * Math.sqrt(Math.max(0, degree));
}

/**
 * Cheap (no layout algorithm) pass over the raw /api/graph payload: derives the prereq/deepens
 * edge list and per-node color/decay/degree metadata. Safe to run over the whole vault on every
 * poll — GraphPanel's force simulation is the only expensive/stateful part, and it's scoped to
 * whichever subset (contextual or whole-vault) is actually on screen.
 */
export function graphMeta(nodes: any[], now: Date): { nodes: GraphNodeMeta[]; edges: LaidOutEdge[] } {
  const slugs = new Set(nodes.map((n) => n.slug));
  const edges: LaidOutEdge[] = [];
  for (const n of nodes) {
    for (const p of n.prereqs) if (slugs.has(p)) edges.push({ src: n.slug, dst: p, type: 'prereq' });
    for (const d of n.deepens) if (slugs.has(d)) edges.push({ src: n.slug, dst: d, type: 'deepens' });
  }

  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }

  const colors = masteryColors(); // resolved once per call, not per node
  const metaNodes: GraphNodeMeta[] = nodes.map((n) => {
    const effective: MasteryLevel = n.mastery?.effective ?? 'unseen';
    // daysLeft is the memory layer's own countdown (get_student_state's days_left), NOT re-derived
    // from a level→window table here — that table knew only mastered/practicing and so overstated a
    // rubric-held page's remaining days (real window 14, table's 21), making the ring and the
    // "Nd until decay" label read long. The window the ring needs back is reconstructed from
    // days_left + elapsed (≈ the true window, rubric-aware, whatever it was), keeping ring and label
    // in agreement. null days_left (slipped, or a level with no decay clock) means no ring, as before.
    let daysLeft: number | null = null, ringFraction: number | null = null;
    const reported: number | null = n.mastery?.days_left ?? null;
    if (reported != null && n.mastery?.last_reinforced) {
      daysLeft = reported;
      const elapsed = Math.max(0, Math.floor((now.getTime() - new Date(n.mastery.last_reinforced).getTime()) / 86_400_000));
      const window = reported + elapsed;
      ringFraction = window > 0 ? reported / window : null;
    }
    return {
      slug: n.slug, title: n.title,
      color: colors[effective], effective, daysLeft, ringFraction,
      misconceptions: n.mastery?.misconceptions ?? [],
      degree: degree.get(n.slug) ?? 0,
    };
  });

  return { nodes: metaNodes, edges };
}
