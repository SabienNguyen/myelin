import {
  useCallback, useEffect, useMemo, useReducer, useRef, useState,
} from 'react';
import { useThreadRuntime } from '@assistant-ui/react';
import {
  forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
  type Simulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from 'd3-force';
import { drag, type D3DragEvent } from 'd3-drag';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom';
import { getGraph } from '../lib/api.js';
import { useRovingKeys, useTablistKeys } from '../lib/tablist.js';
import { graphMeta, radiusForDegree, type GraphNodeMeta, type LaidOutEdge } from '../lib/graphLayout.js';
import { panelBus } from '../lib/panelBus.js';
import { parseHash } from '../lib/urlState.js';

export const POLL_MS = 30_000;

// ── Contextual scope ─────────────────────────────────────────────────────
// /api/graph always returns the WHOLE vault (a vault of hundreds of pages is cheap to fetch and
// keep in memory), but rendering all of it by default drowns out the one topic a student actually
// has open. contextualSubgraph derives a small neighborhood client-side from that already-fetched
// graph instead of asking the server to filter it.
export const CONTEXT_HOPS = 2;
export const CONTEXT_CAP = 40;

// Obsidian's local-graph view always labels every node; its whole-vault view only labels on hover
// or once you've zoomed in, to avoid "label soup". CONTEXT_CAP doubles as that threshold: below
// it, always label (covers contextual mode, and small whole vaults where soup was never a risk
// anyway); at or above it, a label needs hover/neighbor-of-hover or a high enough zoom.
const ALWAYS_LABEL_MAX = CONTEXT_CAP;
const LABEL_ZOOM_THRESHOLD = 1.6;

const LINK_DISTANCE = 60;
const COLLIDE_PAD = 6;

// Zoom-to-fit. The view used to sit at a fixed scale 1 translated to the viewport centre, while the
// simulation laid nodes out at whatever scale the forces produced — so a 5-node subgraph occupied
// ~160px of an ~1100px canvas, dead centre, with its labels piled on top of each other. Fitting the
// node bounding box to the viewport is the actual fix; the label spreading below is secondary.
// Padding is SCREEN pixels held back from the viewport, not simulation units added to the content
// box. The old version added 72 sim units per side, which at the fitted scale meant >100 real pixels
// of margin — the single biggest reason an 8-node graph filled 7% of its canvas.
const FIT_PAD_PX = 28;     // breathing room at the canvas edge, in real pixels
const FIT_LABEL_PX = 22;   // a label hangs below its node; reserve its height at the bottom edge
// No node-size ceiling is needed, because zooming in no longer inflates nodes (see the render's
// `/ Math.max(1, zoomScale)`). That was the whole reason the old ceiling existed and the whole
// reason it bound so early: with everything growing together, "fill the canvas" and "don't turn a
// two-node graph into two dinner plates" were the same knob. They are not any more — zoom now
// spreads positions apart while circles, strokes and type keep their size, so filling is free.
const FIT_MAX_SCALE = 6;   // matches the zoom behaviour's own scaleExtent ceiling
const FIT_MIN_SCALE = 0.15; // matches the zoom behaviour's own scaleExtent floor

// Labels are centred under their node at ~11px. Nodes collided at radius+6, so any two nodes closer
// than a label-width overlapped their text. Widening the collision radius by a FRACTION of the label
// half-width spreads them enough to read without inflating the layout so much that zoom-to-fit
// shrinks everything back again — the two changes have to be tuned against each other.
const LABEL_CHAR_PX = 5.6;
const LABEL_COLLIDE_FACTOR = 0.68;

/** Rendered width estimate for a node's always-on label. Must match what the <text> below actually
 *  prints in its resting state — the decay suffix is hover-only, so including it here would size the
 *  collision radius for a string that is not on screen. */
function labelWidthPx(n: { title: string }): number {
  return n.title.length * LABEL_CHAR_PX;
}

// Membership (this BFS) only ever reads `slug` (for graph structure, via `edges`) and `daysLeft`
// (for the decay-inference fallback below) — never color/degree/etc. Keeping contextualSubgraph
// generic over this minimal shape means it can run directly on GraphNodeMeta (the data-seam
// output of graphLayout.ts's graphMeta), while staying source-compatible with whatever richer
// node shape a caller/test wants to pass (GraphNodeMeta is the default below).
export interface ContextualNode {
  slug: string;
  daysLeft: number | null;
}

export interface Subgraph<N extends ContextualNode = GraphNodeMeta> {
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
 * nodes. Pure and synchronous — the caller already holds the full graph in memory.
 *
 * Cap strategy ("1-hop completeness, then closest-by-degree"): hop-1 neighbors are ALWAYS
 * included in full, even past the cap — a student's immediate prereqs/dependents/deepens links
 * should never be silently dropped. Hop-2 nodes fill any remaining room, highest-degree-in-the-
 * full-graph first: among nodes tied on distance, degree is a cheap proxy for "how central/likely
 * relevant", since raw BFS discovery order (a Map's insertion order) carries no real signal.
 *
 * `requestedSeed` missing (null, or a slug no longer present in `nodes`) falls back to inferring a
 * seed from decay data — the node with the most `daysLeft` (least elapsed time since
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

/** Direct (1-hop) neighbor slugs of `slug`, undirected — the set that lights up on hover
 * (Obsidian's signature interaction: hover a node, see its edges and neighbors, dim the rest).
 * Pure and synchronous so it's unit-testable without a DOM or a running simulation. Does NOT
 * include `slug` itself — callers checking "is this node part of the highlighted set" should
 * check `slug === hovered || neighborSlugs(hovered, edges).has(slug)` explicitly. */
export function neighborSlugs(slug: string, edges: LaidOutEdge[]): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.src === slug) out.add(e.dst);
    else if (e.dst === slug) out.add(e.src);
  }
  return out;
}

// ── Force-directed renderer ──────────────────────────────────────────────
// Both "This topic" and "Whole vault" share this ONE renderer (an Obsidian-style d3-force
// simulation) — the only difference between modes is how many nodes/edges `sub` above hands it.

export interface SimNode extends GraphNodeMeta, SimulationNodeDatum {}
interface SimLink extends SimulationLinkDatum<SimNode> {
  type: 'prereq' | 'deepens';
}
type SimForceLink = ReturnType<typeof forceLink<SimNode, SimLink>>;

function makeSimulation(): Simulation<SimNode, SimLink> {
  const sim = forceSimulation<SimNode, SimLink>([])
    .force('link', forceLink<SimNode, SimLink>([]).id((d) => d.slug)
      .distance(LINK_DISTANCE).strength(0.5))
    .force('charge', forceManyBody<SimNode>().strength((d) => -90 - 14 * d.degree))
    .force('center', forceCenter(0, 0))
    // forceCenter only TRANSLATES the whole system; it exerts no pull between separate components.
    // So a vault with two unconnected clusters (a maths one and a programming one, say) had nothing
    // opposing charge repulsion between them, and they drifted to opposite corners with the middle
    // of the canvas empty — measured at 20% fill on an 8-node vault. These are weak enough not to
    // distort the link layout within a cluster and strong enough to keep the clusters on screen.
    .force('x', forceX<SimNode>(0).strength(0.045))
    .force('y', forceY<SimNode>(0).strength(0.045))
    .force('collide', forceCollide<SimNode>((d) => Math.max(
      radiusForDegree(d.degree) + COLLIDE_PAD,
      (labelWidthPx(d) / 2) * LABEL_COLLIDE_FACTOR,
    )));
  sim.stop(); // idle until the [sub] effect below feeds it real data
  return sim;
}

/** Shortens a src->dst segment at both ends by the given pad, so a straight `<line>` stops at each
 * node's rim instead of running under it (a plain full-length line would bury its own arrowhead
 * marker inside the target node's fill, making prereq direction invisible). Pure geometry, no d3
 * involved — called per edge, per render; cheap even at whole-vault scale. */
function shortenSegment(x1: number, y1: number, x2: number, y2: number, padStart: number, padEnd: number) {
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist, uy = dy / dist;
  return {
    x1: x1 + ux * padStart, y1: y1 + uy * padStart,
    x2: x2 - ux * padEnd, y2: y2 - uy * padEnd,
  };
}

export function GraphPanel({ visible = true }: { visible?: boolean }) {
  const onScopeKeys = useTablistKeys();
  const onNodeKeys = useRovingKeys({ selector: '.graph-node', orientation: 'both', activateOnFocus: false });
  // Raw-ish per-node metadata (color, decay, degree) — cheap to (re)compute for the whole vault on
  // every poll; position lives in the simulation's own node objects (see simRef/nodeObjectsRef
  // below), not here.
  const [meta, setMeta] = useState<{ nodes: GraphNodeMeta[]; edges: LaidOutEdge[] }>({ nodes: [], edges: [] });
  // True until the FIRST fetch+layout has resolved. Gates the "laying out the graph…" placeholder
  // so a student switching to the Graph tab sees that instead of a misleading "open a page to
  // focus" hint or a blank canvas. A plain `let firstLoad` flag inside the load effect (rather than
  // resetting this state elsewhere) means subsequent poll refreshes never flip it back to true.
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'contextual' | 'full'>('contextual');
  // The "currently open page" context signal. Seeded once from the URL (covers a deep link
  // straight into a page, landed on before this component ever sees a panelBus event — GraphPanel
  // is mounted for the whole app lifetime, just CSS-hidden while another tab is active, per
  // SidePanel.tsx), then kept live below by panelBus + hash listeners.
  const [contextSeed, setContextSeed] = useState<string | null>(() => parseHash(location.hash).pageSlug);
  const [hovered, setHovered] = useState<string | null>(null);
  const [labelZoomedIn, setLabelZoomedIn] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  // Never magnify (k>1 divides back out), always let things shrink (k<1 leaves them alone).
  const zoomClamp = Math.max(1, zoomScale);
  const threadRuntime = useThreadRuntime();

  // ── Simulation plumbing (all refs — see the big comment on the [sub] effect for why) ──────
  // Built once, lazily, DURING RENDER (not inside an effect): React commits child refs before a
  // component's own effects run, so a node's drag-behavior ref callback (below) needs the drag
  // behavior — and the simulation it reheats — to already exist the very first time it fires,
  // which is during the SAME commit as this component's first render with real data.
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  if (simRef.current === null) simRef.current = makeSimulation();

  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  if (zoomBehaviorRef.current === null) {
    zoomBehaviorRef.current = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 6])
      .filter((event: any) => {
        if (event.type === 'wheel') return true;
        // A mousedown/touchstart that started ON a node is that node's own d3-drag's job — let it
        // fall through instead of also panning the whole canvas.
        return !(event.target as Element | null)?.closest?.('.graph-node');
      })
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        zoomLayerElRef.current?.setAttribute('transform', event.transform.toString());
        // Everything inside the zoom layer scales, text included — which is why the fit had to be
        // clamped so tightly before: filling the canvas also blew the labels up. Tracking k lets
        // the sizes below divide it back out, so type stays the same physical size at any zoom.
        // Rounded so a wheel gesture doesn't re-render on every sub-percent change.
        setZoomScale((prev) => {
          const next = Math.round(event.transform.k * 100) / 100;
          return prev === next ? prev : next;
        });
        const zoomedIn = event.transform.k >= LABEL_ZOOM_THRESHOLD;
        setLabelZoomedIn((prev) => (prev === zoomedIn ? prev : zoomedIn));
        // `sourceEvent` is null for a programmatic .transform call and set for a real gesture, so this
        // distinguishes "the user chose this view" from "we fitted it". Once the user has panned or
        // zoomed, auto-fit stops fighting them — see fitToNodes.
        if (event.sourceEvent) userAdjustedRef.current = true;
      });
  }

  const dragBehaviorRef = useRef<ReturnType<typeof drag<SVGGElement, SimNode>> | null>(null);
  if (dragBehaviorRef.current === null) {
    dragBehaviorRef.current = drag<SVGGElement, SimNode>()
      // Movement under 4px still fires the node's own onClick afterward (React's synthetic click,
      // untouched by d3-drag) instead of being swallowed as a drag — this is how a tap-to-select
      // and a drag-to-reposition share one node with no extra bookkeeping.
      .clickDistance(4)
      .on('start', (event: D3DragEvent<SVGGElement, SimNode, SimNode>, d: SimNode) => {
        if (!event.active) simRef.current!.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (event: D3DragEvent<SVGGElement, SimNode, SimNode>, d: SimNode) => {
        d.fx = event.x; d.fy = event.y;
      })
      .on('end', (event: D3DragEvent<SVGGElement, SimNode, SimNode>, d: SimNode) => {
        if (!event.active) simRef.current!.alphaTarget(0);
        d.fx = null; d.fy = null;
      });
  }

  // slug -> live simulation node object. Carried across renders (and across polls/reseeds/mode
  // toggles) so metadata refreshes can mutate an already-placed node's color/degree/etc IN PLACE
  // without touching its x/y/vx/vy — the whole trick behind "poll refresh without visual reset":
  // the sim only reheats when membership actually changes (see the [sub] effect), never on a
  // metadata-only refresh, so the graph doesn't re-explode every 30s.
  const nodeObjectsRef = useRef<Map<string, SimNode>>(new Map());
  const nodeElsRef = useRef<Map<string, SVGGElement>>(new Map());
  const nodeRefCallbacksRef = useRef<Map<string, (el: SVGGElement | null) => void>>(new Map());
  const zoomLayerElRef = useRef<SVGGElement | null>(null);

  // Stable (memoized-per-slug) ref callback: React only invokes a ref when its FUNCTION IDENTITY
  // changes, so a fresh inline arrow per render here would thrash drag-attachment on every one of
  // the simulation's ~60fps ticks. This callback only ever records the DOM element — datum
  // binding + drag attachment happens once, in the [sub] effect, for genuinely new nodes only
  // (see there for why: nodeObjectsRef isn't populated for a brand-new slug until that effect
  // runs, which is AFTER this ref callback's mount-time firing).
  const getNodeRefCallback = (slug: string) => {
    let fn = nodeRefCallbacksRef.current.get(slug);
    if (!fn) {
      fn = (el: SVGGElement | null) => {
        if (el) nodeElsRef.current.set(slug, el);
        else nodeElsRef.current.delete(slug);
      };
      nodeRefCallbacksRef.current.set(slug, fn);
    }
    return fn;
  };

  // Held so fitToNodes can measure the viewport and apply a transform outside the ref callback.
  const svgElRef = useRef<SVGSVGElement | null>(null);
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
  // Set by a user gesture (see the zoom handler); cleared when membership changes, because a
  // different node set is a new picture the learner has not positioned yet.
  const userAdjustedRef = useRef(false);

  /**
   * Fits the current node bounding box into the viewport. Skipped once the user has panned/zoomed
   * unless forced (the "fit" button), so an auto-fit can never yank the view out from under someone
   * mid-inspection. Applied through the zoom behaviour rather than by setting the layer transform
   * directly, so d3's internal transform stays in sync and the next wheel gesture continues from
   * here instead of jumping.
   */
  const fitToNodes = useCallback((opts: { force?: boolean } = {}) => {
    const el = svgElRef.current;
    const zb = zoomBehaviorRef.current;
    if (!el || !zb) return;
    if (userAdjustedRef.current && !opts.force) return;
    const nodes = [...nodeObjectsRef.current.values()]
      .filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
    if (nodes.length === 0) return;

    const rect = el.getBoundingClientRect();
    const vw = rect.width || 600;
    const vh = rect.height || 400;
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    let rMaxPx = 0;
    let labelHalfPx = 0;
    for (const n of nodes) {
      minX = Math.min(minX, n.x!); maxX = Math.max(maxX, n.x!);
      minY = Math.min(minY, n.y!); maxY = Math.max(maxY, n.y!);
      // Painted radius is `radiusForDegree(d) / max(1, k)`, so this is its UPPER bound in screen
      // pixels at any zoom — reserving it can over-reserve slightly but can never let the outermost
      // circle, or its decay ring (hence the +6), clip at the canvas edge.
      rMaxPx = Math.max(rMaxPx, radiusForDegree(n.degree) + 6);
      // A label is centred on its node, so it hangs half its width past the node CENTRE — and this
      // box is a box of centres. Reserving only the node radius let the widest label run off the
      // right edge: a screenshot of an 8-node vault had "Stream Consumer" clipped by the canvas,
      // because 45px of label overhang was being covered by ~26px of radius allowance.
      labelHalfPx = Math.max(labelHalfPx, labelWidthPx(n) / 2);
    }
    // max, not sum: both are measured outward from the same node centre.
    const sideMaxPx = Math.max(rMaxPx, labelHalfPx);
    // Box of node CENTRES. A single node (or a perfectly vertical/horizontal pair) gives a
    // zero-width or zero-height box; max(1, ...) keeps the divisions below finite either way.
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    // Everything reserved here is SCREEN space, taken off the viewport before dividing, so each
    // allowance costs a fixed number of real pixels instead of one that grows with the zoom level.
    // The old code added its padding to the content box in SIMULATION units, which is why an
    // 8-node graph ended up with over 100px of margin per side and filled 7% of its canvas.
    const usableW = Math.max(1, vw - FIT_PAD_PX * 2 - sideMaxPx * 2);
    const usableH = Math.max(1, vh - FIT_PAD_PX * 2 - rMaxPx * 2 - FIT_LABEL_PX);
    const scale = Math.max(
      FIT_MIN_SCALE,
      Math.min(FIT_MAX_SCALE, usableW / bw, usableH / bh),
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    select<SVGSVGElement, unknown>(el).call(
      zb.transform,
      zoomIdentity.translate(vw / 2, vh / 2).scale(scale).translate(-cx, -cy),
    );
  }, []);

  /**
   * Re-fit whenever the canvas CHANGES SIZE. 'end' alone is not enough: it fires once per settle,
   * and the panel's box changes long after that — it starts at 0x0 while its tab is hidden (so a
   * fit computed then used the 600x400 fallback), it changes when focus mode collapses the chat to
   * a rail, and it changes on any window resize, which nothing handled at all. Every one of those
   * left a transform fitted to a viewport that no longer exists.
   *
   * Still routed through fitToNodes, so it respects userAdjustedRef: resizing the window does not
   * yank the view away from someone who has panned to a corner.
   */
  useEffect(() => {
    const el = svgEl;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    let last = '';
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width === 0 || box.height === 0) return;
      // Same-size notifications happen (a re-layout that lands on the same box); refitting on them
      // would be pointless work every time the tab is toggled.
      const key = `${Math.round(box.width)}x${Math.round(box.height)}`;
      if (key === last) return;
      last = key;
      cancelAnimationFrame(raf);
      // Deferred a frame so the fit measures the post-layout box, not the one being replaced.
      raf = requestAnimationFrame(() => fitToNodes());
    });
    ro.observe(el);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
    // `svgEl` — the element in STATE, not svgElRef.current — is what makes this effect correct.
    // The <svg> is conditionally rendered (empty vault / load error / canvas), so on the panel's
    // first commit there is no element at all: reading the ref gave null, the effect returned before
    // observing, and nothing in its deps ever changed again once the canvas did mount. Measured:
    // `__roAttached` was undefined after two real resizes, while the fit itself had run 47 times
    // from the simulation tick. The visible symptom was a graph fitted to a viewport that no longer
    // existed — labels clipped off the canvas edge at every size but the first.
  }, [fitToNodes, svgEl]);

  // The tick handler above is installed once and must not re-subscribe on every render, so it
  // reaches the current fitToNodes through this ref rather than closing over one.
  const fitToNodesRef = useRef(fitToNodes);
  fitToNodesRef.current = fitToNodes;

  // Final fit once the forces settle. d3 fires 'end' when alpha decays below alphaMin, which is
  // exactly "the layout has stopped moving".
  useEffect(() => {
    const sim = simRef.current!;
    sim.on('end.fit', () => fitToNodes());
    return () => { sim.on('end.fit', null); };
  }, [fitToNodes]);

  const svgRefCallback = useCallback((el: SVGSVGElement | null) => {
    svgElRef.current = el;
    // Mirrored into state as well as the ref, so effects can depend on the element ARRIVING. See
    // the ResizeObserver effect above for why that distinction was load-bearing.
    setSvgEl(el);
    if (!el || !zoomBehaviorRef.current) return;
    // d3-zoom's default extent() reads the <svg>'s viewBox/width/height SVGAnimatedLength
    // attributes — this svg has neither (it's sized via CSS 100%/100%, see .graph-svg), so that
    // default throws (and even where it doesn't throw, e.g. a real browser, it'd silently read a
    // stale/zero size). Supplying our own extent off getBoundingClientRect sidesteps both.
    zoomBehaviorRef.current.extent((): [[number, number], [number, number]] => {
      const r = el.getBoundingClientRect();
      return [[0, 0], [r.width || 600, r.height || 400]];
    });
    const selection = select<SVGSVGElement, unknown>(el);
    selection.call(zoomBehaviorRef.current);
    const rect = el.getBoundingClientRect();
    const cx = rect.width > 0 ? rect.width / 2 : 300;
    const cy = rect.height > 0 ? rect.height / 2 : 200;
    selection.call(zoomBehaviorRef.current.transform, zoomIdentity.translate(cx, cy));
    return () => { selection.on('.zoom', null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bumps a counter to force a re-render off the simulation's own mutable node objects, instead of
  // mirroring positions into React state — positions change up to ~60x/sec while the sim is
  // settling, and re-reading them straight off simRef's node objects at render time is far cheaper
  // than cloning a fresh array on every tick.
  const [, bump] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    const sim = simRef.current!;
    // Fitting ONLY on 'end' meant the graph sat at scale 1 — a tiny cluster adrift in a big empty
    // canvas — for the ~5 seconds the forces take to settle, then snapped into place. That is the
    // exact picture this whole fix exists to remove, and it was on screen for most of the time
    // anyone spends looking at a freshly-opened graph. Re-fitting as it settles keeps it framed the
    // whole way instead, so the layout grows into the canvas rather than jumping.
    //
    // Throttled to ~10fps: the fit is an O(nodes) bounding box and a transform, cheap enough to run
    // on every one of the ~60 ticks a second, but re-framing that often reads as jitter while the
    // forces are still jiggling. The 'end' handler below still lands the final, exact fit.
    let lastFit = 0;
    sim.on('tick', () => {
      bump();
      const now = performance.now();
      if (now - lastFit < 100) return;
      lastFit = now;
      fitToNodesRef.current();
    });
    return () => { sim.on('tick', null); sim.stop(); };
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let firstLoad = true;
    const load = async () => {
      // Uncaught, this rejected on every poll while the backend was down — an unhandled rejection
      // each tick, and `loading` stuck true forever, so a dead backend was indistinguishable from
      // a slow layout. PagePanel already learned this; the graph had the same hole with a timer
      // behind it.
      try {
        const data = await getGraph();
        if (cancelled) return;
        setMeta(graphMeta(data.nodes ?? [], new Date()));
        setLoadError(null);
      } catch (e) {
        if (cancelled) return;
        // Only surface a failure that leaves nothing on screen. Once a graph has loaded, a failed
        // background poll is not worth replacing a working view with an error.
        if (firstLoad) setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled && firstLoad) { firstLoad = false; setLoading(false); }
      }
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

  // Membership pass: cheap (a BFS over `meta.edges`, no simulation involved) even run over the
  // whole vault, so it's fine to compute unconditionally regardless of `mode`. `contextualSub`
  // recomputes only on a genuine reseed or fresh poll data — NOT on a mode toggle — so flipping
  // back to "This topic" after visiting "Whole vault" doesn't redo the BFS. `fullSub` is a
  // passthrough of every node/edge (memoized separately for the same reason).
  const contextualSub = useMemo(
    () => contextualSubgraph(meta.nodes, meta.edges, contextSeed),
    [meta, contextSeed],
  );
  const fullSub: Subgraph<GraphNodeMeta> = useMemo(
    () => ({ nodes: meta.nodes, edges: meta.edges, seedSlug: null, seedInferred: false, hops: 0, truncated: false }),
    [meta],
  );
  const sub = mode === 'contextual' ? contextualSub : fullSub;

  // Feeds `sub` into the persistent simulation: merges metadata into already-placed nodes IN
  // PLACE (positions untouched), spawns genuinely-new nodes near an already-placed neighbor (if
  // any — organic "grows out of its neighborhood" instead of parachuting in), drops nodes no
  // longer in scope, and reheats the sim ONLY when membership actually changed. A same-membership
  // poll (the common case — metadata like decay/mastery color can still change) or a mode toggle
  // back to an unchanged scope never restarts the sim, so it doesn't re-explode on every 30s poll.
  useEffect(() => {
    const sim = simRef.current!;
    const prevMap = nodeObjectsRef.current;
    const nextMap = new Map<string, SimNode>();
    let membershipChanged = false;

    for (const n of sub.nodes) {
      const existing = prevMap.get(n.slug);
      if (existing) {
        existing.title = n.title;
        existing.color = n.color;
        existing.effective = n.effective;
        existing.daysLeft = n.daysLeft;
        existing.ringFraction = n.ringFraction;
        existing.misconceptions = n.misconceptions;
        existing.degree = n.degree;
        nextMap.set(n.slug, existing);
      } else {
        membershipChanged = true;
        let x = (Math.random() - 0.5) * 20;
        let y = (Math.random() - 0.5) * 20;
        for (const e of sub.edges) {
          const otherSlug = e.src === n.slug ? e.dst : e.dst === n.slug ? e.src : null;
          const other = otherSlug != null ? prevMap.get(otherSlug) : undefined;
          if (other?.x != null && other.y != null) { x += other.x; y += other.y; break; }
        }
        const fresh: SimNode = { ...n, x, y };
        nextMap.set(n.slug, fresh);
        const el = nodeElsRef.current.get(n.slug);
        if (el && dragBehaviorRef.current) select(el).datum(fresh).call(dragBehaviorRef.current as any);
      }
    }
    for (const slug of prevMap.keys()) {
      if (!nextMap.has(slug)) {
        membershipChanged = true;
        nodeElsRef.current.delete(slug);
        nodeRefCallbacksRef.current.delete(slug);
      }
    }
    nodeObjectsRef.current = nextMap;
    if (hovered != null && !nextMap.has(hovered)) setHovered(null);

    const nodesArray = sub.nodes.map((n) => nextMap.get(n.slug)!);
    const linksArray: SimLink[] = sub.edges.map((e) => ({ source: e.src, target: e.dst, type: e.type }));
    sim.nodes(nodesArray);
    sim.force<SimForceLink>('link')!.links(linksArray);
    if (membershipChanged) {
      // A different node set is a picture the learner has not positioned yet, so re-enable auto-fit
      // (a mode toggle or an opened page should reframe) — but a metadata-only refresh must NOT, or a
      // 30s poll would silently undo their panning.
      userAdjustedRef.current = false;
      sim.alpha(1).restart();
    }
    bump(); // repaint immediately even when nothing reheats (e.g. a color-only refresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub]);

  const seedTitle = mode === 'contextual' && sub.seedSlug != null
    ? (meta.nodes.find((n) => n.slug === sub.seedSlug)?.title ?? sub.seedSlug) : null;

  const alwaysShowLabels = sub.nodes.length <= ALWAYS_LABEL_MAX;
  const hoverNeighbors = useMemo(
    () => (hovered != null ? neighborSlugs(hovered, sub.edges) : null),
    [hovered, sub.edges],
  );

  const liveNodes = nodeObjectsRef.current;
  // `hidden` alone does nothing here: the attribute's UA rule is `display: none`, which any explicit
  // `display` in the stylesheet beats — and .graph-controls is `display: flex`. Keep the attribute
  // for semantics and add the class the stylesheet actually acts on.
  const controlsHidden = !loading && sub.nodes.length === 0;

  return (
    <div className="graph-panel">
      {/* The whole control row is hidden on an empty vault: a scope toggle with nothing to scope
          and a "fit" button with nothing to fit are just noise in front of the one sentence that
          tells a new learner what to do. */}
      <div className={`graph-controls${controlsHidden ? ' is-hidden' : ''}`} hidden={controlsHidden}>
        <div className="graph-row">
        <div className="graph-mode-toggle" role="tablist" aria-label="Graph scope" onKeyDown={onScopeKeys}>
          <button type="button" role="tab" aria-selected={mode === 'contextual'}
            tabIndex={mode === 'contextual' ? 0 : -1}
            className={mode === 'contextual' ? 'on' : ''} onClick={() => setMode('contextual')}>
            This topic
          </button>
          <button type="button" role="tab" aria-selected={mode === 'full'}
            tabIndex={mode === 'full' ? 0 : -1}
            className={mode === 'full' ? 'on' : ''} onClick={() => setMode('full')}>
            Whole vault
          </button>
        </div>
        {/* Outside the tablist on purpose: it is an action, not a third scope, and putting a
            non-tab button inside role="tablist" would break the tab semantics for a screen reader.
            `force` because this is the one place an explicit re-fit should override the
            user-adjusted guard. */}
        <div className="graph-actions">
          <button type="button" className="ghost-btn graph-fit" onClick={() => fitToNodes({ force: true })}>
            fit
          </button>
        </div>
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
      ) : sub.nodes.length === 0 ? (
        // Cold start: an empty vault rendered an empty SVG under a full mastery legend — a key to
        // nothing, and no indication that the way to fill it is to go and ask. This is the FIRST
        // thing a new learner sees, and the north star is "help someone learn anything", which
        // begins with nothing in the vault.
        <p className="graph-subtitle graph-empty" role="status">
          Nothing in the graph yet. Ask your tutor about anything you want to learn — pages and the
          links between them are written as you go.
        </p>
      ) : loadError ? (
        <p className="graph-subtitle hint graph-error" role="status">
          {loadError} The graph will reappear on its own once it loads.
        </p>
      ) : (
      <div className="graph-canvas">
        <svg ref={svgRefCallback} className="graph-svg">
          <defs>
            <marker id="graph-arrow" viewBox="0 0 10 10" refX="8" refY="5"
              markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--text-muted)" />
            </marker>
          </defs>
          <g ref={(el) => { zoomLayerElRef.current = el; }}>
            <g className="graph-edges">
              {sub.edges.map((e) => {
                const src = liveNodes.get(e.src);
                const dst = liveNodes.get(e.dst);
                if (!src || !dst || src.x == null || src.y == null || dst.x == null || dst.y == null) return null;
                // Same /zoomClamp as the node render below. An edge is trimmed back by its
                // endpoints' radii so it meets the circle rather than the centre; trimming by the
                // UNSCALED radius while the circles are painted smaller leaves every arrow
                // floating in space, which is exactly what happened when nodes stopped inflating.
                const srcR = radiusForDegree(src.degree) / zoomClamp;
                const dstR = radiusForDegree(dst.degree) / zoomClamp;
                const isHoverEdge = hovered != null && (e.src === hovered || e.dst === hovered);
                const dimmed = hovered != null && !isHoverEdge;
                if (e.type === 'deepens') {
                  const seg = shortenSegment(src.x, src.y, dst.x, dst.y, srcR + 2 / zoomClamp, dstR + 2 / zoomClamp);
                  return (
                    <line key={`deepens-${e.src}-${e.dst}`} x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
                      className={`graph-edge graph-edge-deepens${dimmed ? ' dim' : ''}`} />
                  );
                }
                const seg = shortenSegment(src.x, src.y, dst.x, dst.y, srcR + 2 / zoomClamp, dstR + 7 / zoomClamp);
                return (
                  <line key={`prereq-${e.src}-${e.dst}`} x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
                    className={`graph-edge graph-edge-prereq${dimmed ? ' dim' : ''}`}
                    markerEnd="url(#graph-arrow)" />
                );
              })}
            </g>
            {/* The graph was mouse-only: nodes had a click handler and nothing else, so the app's
                most information-dense surface was unreachable by keyboard and announced nothing.
                One tab stop for the whole group, arrows between nodes, Enter/Space to open — the
                same roving-focus contract the tab strips use. Activation is MANUAL here (unlike the
                tab strips): arrowing across a graph should not fire a page navigation per keypress.
                The mastery list under the canvas remains the text equivalent of the layout itself,
                which no amount of focus management can convey. */}
            <g className="graph-nodes" role="group" aria-label="Concept nodes" onKeyDown={onNodeKeys}>
              {sub.nodes.map((n, nodeIndex) => {
                const live = liveNodes.get(n.slug);
                const x = live?.x ?? 0;
                const y = live?.y ?? 0;
                // Painted size, not layout size. Dividing by the clamped zoom keeps a node the
                // same physical dot as the view zooms IN (so filling the canvas spreads the graph
                // out instead of inflating it), while still shrinking normally as it zooms OUT —
                // where the collision force reserved only simulation units, so holding size
                // constant would let a dense whole-vault view overlap itself.
                const r = radiusForDegree(n.degree) / zoomClamp;
                const isHovered = hovered === n.slug;
                const isNeighbor = hovered != null && (hoverNeighbors?.has(n.slug) ?? false);
                const dimmed = hovered != null && !isHovered && !isNeighbor;
                const showLabel = alwaysShowLabels || isHovered || isNeighbor || labelZoomedIn;
                return (
                  <g key={n.slug} ref={getNodeRefCallback(n.slug)}
                    className={`graph-node${dimmed ? ' dim' : ''}`}
                    transform={`translate(${x},${y})`}
                    role="link"
                    // The <title> below is the tooltip; aria-label is what a screen reader reads,
                    // and it has to carry the mastery and decay a sighted user gets from the node's
                    // colour and ring — those are the only place that information exists.
                    aria-label={`${n.title}, ${n.effective}${n.daysLeft != null ? `, ${n.daysLeft} days until decay` : ''}${n.misconceptions.length > 0 ? ', has a recorded misconception' : ''}`}
                    // Roving tabindex: the selected node if there is one, else the first, so the
                    // group is a single Tab stop that resumes where the learner left off.
                    tabIndex={(selected != null ? selected === n.slug : nodeIndex === 0) ? 0 : -1}
                    onClick={() => { setSelected(n.slug); panelBus.openPage(n.slug); }}
                    onKeyDown={(ev) => {
                      if (ev.key !== 'Enter' && ev.key !== ' ') return;
                      ev.preventDefault();   // Space would otherwise scroll the panel.
                      ev.stopPropagation();  // and the worked-example player binds Space globally.
                      setSelected(n.slug);
                      panelBus.openPage(n.slug);
                    }}
                    // Focus doubles as hover so the neighbour highlighting — the thing that makes
                    // an edge readable — is not a mouse-only affordance either.
                    onFocus={() => setHovered(n.slug)}
                    onBlur={() => setHovered((h) => (h === n.slug ? null : h))}
                    onMouseEnter={() => setHovered(n.slug)}
                    onMouseLeave={() => setHovered((h) => (h === n.slug ? null : h))}
                    style={{ cursor: 'pointer' }}>
                    <title>{`${n.title} — ${n.effective}${n.daysLeft != null ? `, ${n.daysLeft}d until decay` : ''}`}</title>
                    <circle r={r} fill={n.color} />
                    {/* Focus ring. Rendered always, revealed by CSS on :focus-visible — a
                        conditional element would rebuild the subtree on every focus move. */}
                    <circle className="graph-focus-ring" r={r + 6 / zoomClamp} />
                    {n.ringFraction != null && (
                      <circle r={r + 4 / zoomClamp} fill="none" stroke={n.color} strokeWidth={2 / zoomClamp}
                        pathLength={100} strokeDasharray={`${n.ringFraction * 100} 100`}
                        transform="rotate(-90)" />
                    )}
                    {n.misconceptions.length > 0 && (
                      <g>
                        <title>{n.misconceptions.join('; ')}</title>
                        {/* Offsets divided too — a bare 6 here is 6 SIMULATION units, which at a
                            fitted scale of 5 flung the marker 30px off its own node. */}
                        <text x={r - 6 / zoomClamp} y={-r + 6 / zoomClamp} fontSize={12 / zoomScale}>⚠</text>
                      </g>
                    )}
                    {showLabel && (
                      // The decay suffix is detail-on-demand: the ring arc already encodes time-till-
                      // decay visually and the <title> above carries the exact number, so printing
                      // " · 45d" on every label only widened every label and drove the label
                      // collisions (the hub "Derivatives · 45d" overlapped its neighbours at any
                      // spreading strength worth using). Shown on hover/selection, where it is
                      // actually being read.
                      <text y={r + 14 / zoomScale} textAnchor="middle" fontSize={11 / zoomScale}>
                        {n.title}
                        {(isHovered || selected === n.slug) && n.daysLeft != null ? ` · ${n.daysLeft}d` : ''}
                      </text>
                    )}
                    {selected === n.slug && (
                      // Shrinking the box alone was not enough: foreignObject CONTENT is HTML, so
                      // the button's CSS pixels scale with the SVG transform too and would burst
                      // out of a smaller box. Counter-scaling the whole group instead makes every
                      // number inside it a real screen pixel — including the button's own type.
                      // r * zoomClamp is r_sim, since r above is r_sim / zoomClamp.
                      <g transform={`scale(${1 / zoomClamp})`}>
                        {/* Real screen pixels now that the group counter-scales, so this has to
                            actually fit the rendered label — at 90x26 it clipped to "Teach". */}
                        <foreignObject x={-64} y={r * zoomClamp + 18} width={128} height={32}>
                          <button
                            onClick={(ev) => { ev.stopPropagation(); threadRuntime.append(`Teach me ${n.slug} now`); }}
                          >
                            Teach me this
                          </button>
                        </foreignObject>
                      </g>
                    )}
                  </g>
                );
              })}
            </g>
          </g>
        </svg>
      </div>
      )}
      {/* Also gated on loadError: a mastery legend under an error message is a key to a graph that
          is not there. */}
      {!loading && !loadError && sub.nodes.length > 0 && (
      <div className="graph-legend">
        {/* var(--mastery-*), not literal hex: the tokens in styles.css are the single source these
            swatches and lib/graphLayout.ts's node fills both read, so the legend can no longer
            disagree with the graph it describes, and both follow the colour scheme. */}
        <span><i className="dot" style={{ background: 'var(--mastery-unseen)' }} /> unseen</span>
        <span><i className="dot" style={{ background: 'var(--mastery-exposed)' }} /> exposed</span>
        <span><i className="dot" style={{ background: 'var(--mastery-practicing)' }} /> practicing</span>
        <span><i className="dot" style={{ background: 'var(--mastery-mastered)' }} /> mastered</span>
        <span><i className="ring" /> time till decay</span>
        <span>⚠ misconception</span>
      </div>
      )}
    </div>
  );
}
