import type { MasteryGraph } from './buildGraph.js';

/** focus + its direct neighbours (either direction), or null when nothing is focused. */
export function focusNeighbourhood(graph: MasteryGraph, focus: string | null): Set<string> | null {
  if (focus == null || !graph.hasNode(focus)) return null;
  return new Set([focus, ...graph.neighbors(focus)]);
}

/** sigma nodeReducer: null set → data unchanged. In set → { ...data, zIndex: 1, forceLabel: true,
 *  highlighted: node === focus }. Outside → { ...data, color: mutedColor, label: '', zIndex: 0 }. */
export function nodeReducer(focus: string | null, set: ReadonlySet<string> | null, mutedColor: string):
  (node: string, data: Record<string, unknown>) => Record<string, unknown> {
  return (node, data) => {
    if (set === null) return data;
    if (set.has(node)) return { ...data, zIndex: 1, forceLabel: true, highlighted: node === focus };
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
