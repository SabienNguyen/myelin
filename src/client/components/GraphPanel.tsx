import { useEffect, useMemo, useState } from 'react';
import { useThreadRuntime } from '@assistant-ui/react';
import { getArrow } from 'perfect-arrows';
import { getGraph } from '../lib/api.js';
import {
  graphMeta, positionNodes, type GraphNodeMeta, type LaidOutNode, type LaidOutEdge,
} from '../lib/graphLayout.js';
import { panelBus } from '../lib/panelBus.js';
import { parseHash } from '../lib/urlState.js';

const R = 16;
const PAD = 60;
export const POLL_MS = 30_000;

// Tuned low so the layered (mostly-vertical) layout reads as refined arcs
// rather than the swoopy default perfect-arrows curves.
const PREREQ_ARROW_OPTS = { bow: 0.15, stretch: 0.3, padStart: R + 2, padEnd: R + 7 };

// ── Contextual scope ─────────────────────────────────────────────────────
// /api/graph always returns the WHOLE vault (a vault of hundreds of pages is cheap to fetch and
// keep in memory), but rendering all of it by default drowns out the one topic a student actually
// has open. contextualSubgraph derives a small neighborhood client-side from that already-fetched
// graph instead of asking the server to filter it.
export const CONTEXT_HOPS = 2;
export const CONTEXT_CAP = 40;

// Membership (this BFS) only ever reads `slug` (for graph structure, via `edges`) and `daysLeft`
// (for the decay-inference fallback below) — never position/color/etc. Keeping contextualSubgraph
// generic over this minimal shape means it can run BEFORE the (expensive) layout pass, directly on
// GraphNodeMeta (un-laid) nodes, while staying source-compatible with the already-laid-out
// LaidOutNode[] fixtures the existing tests below construct.
export interface ContextualNode {
  slug: string;
  daysLeft: number | null;
}

export interface Subgraph<N extends ContextualNode = LaidOutNode> {
  nodes: N[];
  edges: LaidOutEdge[];
  /** BFS origin actually used — null only when there's truly no usable seed (nothing open this
   * session, no decay data to infer one from either), in which case `nodes`/`edges` above are
   * simply the full graph, unfiltered, and the caller should show the "open a page" hint. */
  seedSlug: string | null;
  /** True when seedSlug wasn't the caller's requested seed but was inferred from decay data. */
  seedInferred: boolean;
  hops: number;
  /** True when the 2-hop neighborhood exceeded `cap` and some hop-2 nodes were dropped to fit —
   * hop-1 neighbors are never dropped, see the trim step below. */
  truncated: boolean;
}

/**
 * Undirected BFS neighborhood of `requestedSeed` within CONTEXT_HOPS hops, capped at ~`cap`
 * nodes. Pure and synchronous — the caller already holds the full laid-out graph in memory.
 *
 * Cap strategy ("1-hop completeness, then closest-by-degree"): hop-1 neighbors are ALWAYS
 * included in full, even past the cap — a student's immediate prereqs/dependents/deepens links
 * should never be silently dropped. Hop-2 nodes fill any remaining room, highest-degree-in-the-
 * full-graph first: among nodes tied on distance, degree is a cheap proxy for "how central/likely
 * relevant", since raw BFS discovery order (a Map's insertion order) carries no real signal.
 *
 * `requestedSeed` missing (null, or a slug no longer present in `nodes`) falls back to inferring a
 * seed from decay data — the LaidOutNode with the most `daysLeft` (least elapsed time since
 * `last_reinforced`, i.e. the freshest "recently touched" node the already-fetched graph exposes)
 * — and, if nothing has decay data either, all the way to the whole graph with `seedSlug: null`.
 */
export function contextualSubgraph<N extends ContextualNode>(
  nodes: N[], edges: LaidOutEdge[], requestedSeed: string | null, cap: number = CONTEXT_CAP,
): Subgraph<N> {
  const bySlug = new Map(nodes.map((n) => [n.slug, n]));
  let seedSlug = requestedSeed != null && bySlug.has(requestedSeed) ? requestedSeed : null;
  let seedInferred = false;
  if (seedSlug == null) {
    const withDecay = nodes.filter((n) => n.daysLeft != null);
    if (withDecay.length > 0) {
      seedSlug = withDecay.reduce((freshest, n) => (n.daysLeft! > freshest.daysLeft! ? n : freshest)).slug;
      seedInferred = true;
    }
  }
  if (seedSlug == null) {
    return { nodes, edges, seedSlug: null, seedInferred: false, hops: 0, truncated: false };
  }

  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const e of edges) { link(e.src, e.dst); link(e.dst, e.src); }

  const distance = new Map<string, number>([[seedSlug, 0]]);
  let frontier = [seedSlug];
  for (let hop = 1; hop <= CONTEXT_HOPS && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const nb of adjacency.get(cur) ?? []) {
        if (!distance.has(nb)) { distance.set(nb, hop); next.push(nb); }
      }
    }
    frontier = next;
  }

  const hop1 = [...distance].filter(([, d]) => d === 1).map(([s]) => s);
  const hop2 = [...distance].filter(([, d]) => d === 2).map(([s]) => s);

  const included = new Set<string>([seedSlug, ...hop1]);
  const room = cap - included.size;
  let truncated: boolean;
  if (room > 0) {
    const degree = (slug: string) => adjacency.get(slug)?.size ?? 0;
    const ranked = [...hop2].sort((a, b) => degree(b) - degree(a) || a.localeCompare(b));
    for (const slug of ranked.slice(0, room)) included.add(slug);
    truncated = ranked.length > room;
  } else {
    truncated = hop2.length > 0;
  }

  return {
    nodes: nodes.filter((n) => included.has(n.slug)),
    edges: edges.filter((e) => included.has(e.src) && included.has(e.dst)),
    seedSlug, seedInferred, hops: CONTEXT_HOPS, truncated,
  };
}

export function GraphPanel({ visible = true }: { visible?: boolean }) {
  // Raw-ish per-node metadata (color, decay, edges) — cheap to (re)compute for the whole vault on
  // every poll; does NOT include x/y. Position is computed separately, below, only for whichever
  // subset actually gets displayed (see `displayNodes`).
  const [meta, setMeta] = useState<{ nodes: GraphNodeMeta[]; edges: LaidOutEdge[] }>({ nodes: [], edges: [] });
  // True until the FIRST fetch+layout has resolved. Gates the "laying out the graph…" placeholder
  // so a student switching to the Graph tab sees that instead of a misleading "open a page to
  // focus" hint or a blank canvas. A plain `let firstLoad` flag inside the load effect (rather than
  // resetting this state elsewhere) means subsequent poll refreshes never flip it back to true.
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'contextual' | 'full'>('contextual');
  // The "currently open page" context signal. Seeded once from the URL (covers a deep link
  // straight into a page, landed on before this component ever sees a panelBus event — GraphPanel
  // is mounted for the whole app lifetime, just CSS-hidden while another tab is active, per
  // SidePanel.tsx), then kept live below by panelBus + hash listeners.
  const [contextSeed, setContextSeed] = useState<string | null>(() => parseHash(location.hash).pageSlug);
  const threadRuntime = useThreadRuntime();

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let firstLoad = true;
    const load = async () => {
      const data = await getGraph();
      if (cancelled) return;
      setMeta(graphMeta(data.nodes ?? [], new Date()));
      if (firstLoad) { firstLoad = false; setLoading(false); }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [visible]);

  // Tracks the scope seed regardless of which tab is visible (this effect has no `visible` gate)
  // so that switching to Graph after opening a page elsewhere shows an already-correct context,
  // instead of a stale one that only updates the next time an openPage event fires while visible.
  // Two sources, because the app has two ways a page's slug changes (see SidePanel.tsx): most
  // opens go through panelBus (wiki-link clicks, graph node clicks, `teachMe`), but direct/back-
  // forward hash navigation bypasses panelBus entirely — the hash listener catches that case. A
  // hash change is only applied when it actually names a page, so switching tabs in the URL (which
  // drops the page segment — see urlState.ts's serializeHash) never clears a known context.
  useEffect(() => {
    const unsub = panelBus.subscribe((e) => {
      if (e.type === 'openPage' || e.type === 'teachMe') setContextSeed(e.slug);
    });
    const onHashChange = () => {
      const parsed = parseHash(location.hash);
      if (parsed.tab === 'page' && parsed.pageSlug) setContextSeed(parsed.pageSlug);
    };
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onHashChange);
    return () => {
      unsub();
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onHashChange);
    };
  }, []);

  // Membership pass: cheap (a BFS over `meta.edges`, no layout algorithm) even run over the whole
  // vault, so it's fine to compute unconditionally regardless of `mode`. `contextualSub` recomputes
  // only on a genuine reseed or fresh poll data — NOT on a mode toggle — so flipping back to "This
  // topic" after visiting "Whole vault" doesn't redo the BFS. `fullSub` is a passthrough of every
  // node/edge (memoized separately for the same reason).
  const contextualSub = useMemo(
    () => contextualSubgraph(meta.nodes, meta.edges, contextSeed),
    [meta, contextSeed],
  );
  const fullSub: Subgraph<GraphNodeMeta> = useMemo(
    () => ({ nodes: meta.nodes, edges: meta.edges, seedSlug: null, seedInferred: false, hops: 0, truncated: false }),
    [meta],
  );
  const sub = mode === 'contextual' ? contextualSub : fullSub;

  // Position pass: the (comparatively expensive) sugiyama/dagre layout, run ONLY over `sub.nodes`
  // — i.e. the already-filtered membership above, not the whole vault. In contextual mode with a
  // live seed this is bounded by CONTEXT_CAP; laying out the full node set only happens for the
  // seedless fallback (see contextualSubgraph's doc comment) or "Whole vault" mode, both of which
  // genuinely need every node positioned.
  //
  // This IS still a synchronous call inline in render, so switching to "Whole vault" on a large
  // vault can still cost a visible beat with the last-painted (contextual) view frozen on screen
  // until the new layout commits — we don't reuse the "laying out the graph…" placeholder around
  // it. Doing so would mean yielding to the browser (e.g. a setTimeout(0) deferral) between setting
  // a loading flag and running the layout, purely to guarantee an intermediate paint; that's a
  // second loading-state pathway (with its own once-per-toggle semantics) layered on top of the
  // first-load one above, for a rare, user-initiated, already one-off action — not worth the added
  // complexity here. The strict win over the old behavior stands regardless: that same freeze used
  // to happen on every load/poll, in every mode; now it's scoped to the explicit "Whole vault" ask.
  const displayNodes = useMemo(() => positionNodes(sub.nodes), [sub]);
  const displayEdges = sub.edges;
  const seedTitle = mode === 'contextual' && sub.seedSlug != null
    ? (meta.nodes.find((n) => n.slug === sub.seedSlug)?.title ?? sub.seedSlug) : null;

  const byId = new Map(displayNodes.map((n) => [n.slug, n]));
  const xs = displayNodes.map((n) => n.x);
  const ys = displayNodes.map((n) => n.y);
  const minX = (xs.length ? Math.min(...xs) : 0) - PAD;
  const minY = (ys.length ? Math.min(...ys) : 0) - PAD;
  const maxX = (xs.length ? Math.max(...xs) : 200) + PAD;
  const maxY = (ys.length ? Math.max(...ys) : 200) + PAD;
  const width = maxX - minX;
  const height = maxY - minY;

  return (
    <div className="graph-panel" style={{ overflow: 'auto', width: '100%', height: '100%' }}>
      <div className="graph-controls">
        <div className="graph-mode-toggle" role="tablist" aria-label="Graph scope">
          <button type="button" role="tab" aria-selected={mode === 'contextual'}
            className={mode === 'contextual' ? 'on' : ''} onClick={() => setMode('contextual')}>
            This topic
          </button>
          <button type="button" role="tab" aria-selected={mode === 'full'}
            className={mode === 'full' ? 'on' : ''} onClick={() => setMode('full')}>
            Whole vault
          </button>
        </div>
        {/* Never show the "open a page" hint (nor an empty-looking canvas below) while the first
            load+layout is still in flight — both would misleadingly read as "there's nothing
            here" rather than "still working on it". */}
        {!loading && mode === 'contextual' && (
          seedTitle != null ? (
            <p className="graph-subtitle">
              around {seedTitle} · {sub.hops} hops
              {sub.nodes.length === 1 && ' · no linked pages yet'}
              {sub.truncated && ' · showing closest matches'}
            </p>
          ) : (
            <p className="graph-subtitle hint">open a page to focus the graph</p>
          )
        )}
      </div>
      {loading ? (
        <p className="graph-subtitle hint graph-loading">laying out the graph…</p>
      ) : (
      <svg viewBox={`${minX} ${minY} ${width} ${height}`} width={width} height={height}>
        {displayEdges.map((e) => {
          const src = byId.get(e.src);
          const dst = byId.get(e.dst);
          if (!src || !dst) return null;
          if (e.type === 'deepens') {
            // Dashed S-curve (curveBumpY-style): leave/enter nodes vertically, stop at the rim.
            const dir = dst.y > src.y ? 1 : -1;
            const y1 = src.y + dir * (R + 2);
            const y2 = dst.y - dir * (R + 7);
            const my = (y1 + y2) / 2;
            const d = `M ${src.x} ${y1} C ${src.x} ${my}, ${dst.x} ${my}, ${dst.x} ${y2}`;
            return (
              <path key={`deepens-${e.src}-${e.dst}`} d={d} fill="none"
                stroke="#888" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.5} />
            );
          }
          // Prereq edges: perfect-arrows tapered arc, padded to stop at each node's rim.
          const [sx, sy, cx, cy, ex, ey, ae] = getArrow(src.x, src.y, dst.x, dst.y, PREREQ_ARROW_OPTS);
          const endAngleDeg = ae * (180 / Math.PI);
          return (
            <g key={`prereq-${e.src}-${e.dst}`}>
              <path d={`M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`} fill="none" stroke="#888" strokeWidth={1.5} />
              <polygon points="0,-5 10,0 0,5" fill="#888"
                transform={`translate(${ex},${ey}) rotate(${endAngleDeg})`} />
            </g>
          );
        })}
        {displayNodes.map((n) => (
          <g key={n.slug} className="graph-node" transform={`translate(${n.x},${n.y})`}
            onClick={() => { setSelected(n.slug); panelBus.openPage(n.slug); }}
            style={{ cursor: 'pointer' }}>
            <title>{`${n.title} — ${n.effective}${n.daysLeft != null ? `, ${n.daysLeft}d until decay` : ''}`}</title>
            <circle r={R} fill={n.color} />
            {n.ringFraction != null && (
              <circle r={R + 4} fill="none" stroke={n.color} strokeWidth={2}
                pathLength={100} strokeDasharray={`${n.ringFraction * 100} 100`}
                transform="rotate(-90)" />
            )}
            {n.misconceptions.length > 0 && (
              <g>
                <title>{n.misconceptions.join('; ')}</title>
                <text x={R - 6} y={-R + 6} fontSize={12}>⚠</text>
              </g>
            )}
            <text y={R + 14} textAnchor="middle" fontSize={11}>
              {n.title}{n.daysLeft != null ? ` · ${n.daysLeft}d` : ''}
            </text>
            {selected === n.slug && (
              <foreignObject x={-45} y={R + 20} width={90} height={26}>
                <button
                  onClick={(ev) => { ev.stopPropagation(); threadRuntime.append(`Teach me ${n.slug} now`); }}
                >
                  Teach me this
                </button>
              </foreignObject>
            )}
          </g>
        ))}
      </svg>
      )}
      {!loading && (
      <div className="graph-legend">
        <span><i className="dot" style={{ background: '#9e9e9e' }} /> unseen</span>
        <span><i className="dot" style={{ background: '#e0b040' }} /> exposed</span>
        <span><i className="dot" style={{ background: '#5b8def' }} /> practicing</span>
        <span><i className="dot" style={{ background: '#4caf7d' }} /> mastered</span>
        <span><i className="ring" /> time till decay</span>
        <span>⚠ misconception</span>
      </div>
      )}
    </div>
  );
}
