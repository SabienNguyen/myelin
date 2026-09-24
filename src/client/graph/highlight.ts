import type { MasteryGraph } from './buildGraph.js';

/** focus + its direct neighbours (either direction), or null when nothing is focused. */
export function focusNeighbourhood(graph: MasteryGraph, focus: string | null): Set<string> | null {
  if (focus == null || !graph.hasNode(focus)) return null;
  return new Set([focus, ...graph.neighbors(focus)]);
}

// Forced labels are drawn whether or not they collide: labelling every neighbour of a hub piled
// "U-Substitution" onto "Fundamental Theorem of Calculus" and ran the Teach button over another.
export const HOVER_LABELS = 6;

/** The nodes whose labels a hover forces on: the focus and its HOVER_LABELS best-linked
 *  neighbours (whole-vault degree, then slug). The rest of the neighbourhood stays highlighted and
 *  is labelled only where sigma's label grid finds room. */
export function hoverLabelled(graph: MasteryGraph, focus: string | null, set: ReadonlySet<string> | null): Set<string> | null {
  if (focus == null || set === null) return null;
  const neighbours = [...set].filter((n) => n !== focus);
  neighbours.sort((a, b) => graph.getNodeAttribute(b, 'degree') - graph.getNodeAttribute(a, 'degree') || (a < b ? -1 : 1));
  return new Set([focus, ...neighbours.slice(0, HOVER_LABELS)]);
}

/** sigma nodeReducer: null set → data unchanged. In set → { ...data, zIndex: 1, forceLabel (only for
 *  `labelled`, which defaults to the whole set), highlighted: node === focus }. Outside →
 *  { ...data, color: mutedColor, label: '', zIndex: 0 }. */
export function nodeReducer(
  focus: string | null, set: ReadonlySet<string> | null, mutedColor: string,
  labelled: ReadonlySet<string> | null = set,
): (node: string, data: Record<string, unknown>) => Record<string, unknown> {
  return (node, data) => {
    if (set === null) return data;
    if (set.has(node)) return { ...data, zIndex: 1, forceLabel: labelled?.has(node) ?? false, highlighted: node === focus };
    return { ...data, color: mutedColor, label: '', zIndex: 0 };
  };
}

/** sigma edgeReducer: null set → unchanged. Both endpoints in set → { ...data, zIndex: 1,
 *  size: (data.size as number) * 1.6 }. Otherwise → { ...data, color: mutedColor, zIndex: 0 }. */
export function edgeReducer(graph: MasteryGraph, set: ReadonlySet<string> | null, mutedColor: string):
  (edge: string, data: Record<string, unknown>) => Record<string, unknown> {
  return (edge, data) => {
    if (set === null) return data;
    const [src, dst] = graph.extremities(edge);
    if (set.has(src) && set.has(dst)) return { ...data, zIndex: 1, size: (data.size as number) * 1.6 };
    return { ...data, color: mutedColor, zIndex: 0 };
  };
}
