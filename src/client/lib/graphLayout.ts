import dagre from 'dagre';
import { DECAY, type MasteryLevel } from '../../shared/loreweaver.js';

const COLORS: Record<MasteryLevel, string> = {
  unseen: '#9e9e9e', exposed: '#e0b040', practicing: '#5b8def', mastered: '#4caf7d',
};
const WINDOW: Partial<Record<MasteryLevel, number>> = {
  mastered: DECAY.masteredDays, practicing: DECAY.practicingDays,
};

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

export function layoutGraph(nodes: any[], now: Date): { nodes: LaidOutNode[]; edges: LaidOutEdge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'BT', nodesep: 40, ranksep: 70 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.slug, { width: 120, height: 60 });
  const edges: { src: string; dst: string; type: 'prereq' | 'deepens' }[] = [];
  for (const n of nodes) {
    // Layout edge is prereq -> dependent (foundation ranks below what it supports under rankdir BT);
    // the rendered edge direction (src: dependent, dst: prereq) is tracked separately in `edges`.
    for (const p of n.prereqs) if (g.hasNode(p)) { g.setEdge(p, n.slug); edges.push({ src: n.slug, dst: p, type: 'prereq' }); }
    for (const d of n.deepens) if (g.hasNode(d)) edges.push({ src: n.slug, dst: d, type: 'deepens' });
  }
  dagre.layout(g);
  return {
    nodes: nodes.map((n) => {
      const pos = g.node(n.slug);
      const effective: MasteryLevel = n.mastery?.effective ?? 'unseen';
      const window = WINDOW[effective];
      let daysLeft: number | null = null, ringFraction: number | null = null;
      if (window && n.mastery?.last_reinforced) {
        const elapsed = Math.floor((now.getTime() - new Date(n.mastery.last_reinforced).getTime()) / 86_400_000);
        daysLeft = Math.max(0, window - elapsed);
        ringFraction = daysLeft / window;
      }
      return {
        slug: n.slug, title: n.title, x: pos.x, y: pos.y,
        color: COLORS[effective], effective, daysLeft, ringFraction,
        misconceptions: n.mastery?.misconceptions ?? [],
      };
    }),
    edges: edges.map((e) => ({ ...e })),
  };
}
