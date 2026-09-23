import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { useThreadRuntime } from '@assistant-ui/react';
// sigma's bundle reads WebGLRenderingContext/WebGL2RenderingContext constants AT MODULE LOAD (see
// tests/client/nodeProgram.test.ts's comment) — a static `import Sigma from 'sigma'` would make
// THIS FILE throw on import in jsdom and in any browser without WebGL. Only `import type` here;
// the mount effect below loads the real module (and nodeProgram.ts, which has the same problem)
// lazily and routes a failure into the WebGL-unavailable fallback.
import type Sigma from 'sigma';
import type { MouseCoords, SigmaNodeEventPayload } from 'sigma/types';
import { WarningIcon as Warning } from '@phosphor-icons/react';
import { MultiDirectedGraph as Graph } from 'graphology';
import { getGraph } from '../lib/api.js';
import { useRovingKeys, useTablistKeys } from '../lib/tablist.js';
import { graphMeta, type GraphNodeMeta, type LaidOutEdge } from '../lib/graphLayout.js';
import { panelBus } from '../lib/panelBus.js';
import { parseHash } from '../lib/urlState.js';
import {
  resolveGraphColors, syncGraph, type MasteryGraph, type GraphColors,
} from '../graph/buildGraph.js';
import { createLayout, type LayoutController } from '../graph/layout.js';
import { loadPositions, savePositions } from '../graph/positionStore.js';
import { focusNeighbourhood, nodeReducer, edgeReducer } from '../graph/highlight.js';

export const POLL_MS = 30_000;

// ── Contextual scope ─────────────────────────────────────────────────────
// /api/graph always returns the WHOLE vault (a vault of hundreds of pages is cheap to fetch and
// keep in memory), but rendering all of it by default drowns out the one topic a student actually
// has open. contextualSubgraph derives a small neighborhood client-side from that already-fetched
// graph instead of asking the server to filter it.
export const CONTEXT_HOPS = 2;
export const CONTEXT_CAP = 40;

// Above this node count, sigma keeps redrawing edges/labels every frame while the camera is
// moving (panning or the still-running layout) at a real, measured cost: a synthetic 5,000-node /
// 12,000-edge run panned at p50 137ms/frame with these off, against a 20ms target (graph-perf.e2e.ts).
// hideEdgesOnMove/hideLabelsOnMove drop that work while movement is happening; a small graph never
// gets slow enough to need it, and always hiding edges there would just make hovering less useful.
const LARGE_GRAPH_NODES = 1_000;
// Above CONTEXT_CAP, forceLabel is off (see syncGraph's opts.forceLabels below) and sigma's label
// grid picks which labels to draw. A 400-node whole-vault screenshot showed labels overlapping
// each other in the dense centre at the default labelDensity/labelGridCellSize — fewer, larger
// grid cells thin that out; a contextual view never reaches this path since every one of its ≤40
// labels is forced on regardless of density.
const DENSE_LABEL_DENSITY = 0.35;
const DENSE_LABEL_GRID_CELL_SIZE = 140;

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

/** The accessible name suffix for a topic-list button — the same facts the old SVG node's
 * aria-label carried (mastery+decay had no other home once the canvas became aria-hidden), so a
 * screen-reader user loses nothing by the canvas no longer being their interaction surface. */
function factsFor(n: GraphNodeMeta): string {
  const facts: string[] = [n.effective];
  if (n.daysLeft != null) facts.push(`${n.daysLeft} ${n.daysLeft === 1 ? 'day' : 'days'} until decay`);
  if (n.slipped) facts.push('slipping — due for review');
  if (n.misconceptions.length > 0) facts.push('has a recorded misconception');
  return facts.join(', ');
}

const FIT_ANIMATION_MS = 300;
// How long a released drag keeps the worker running so neighbours can settle around the node's
// new position — mirrors LAYOUT.releaseRunMs, kept here only as the doc anchor for that behaviour.

export function GraphPanel({ visible = true }: { visible?: boolean }) {
  const onScopeKeys = useTablistKeys();
  const onTopicKeys = useRovingKeys({ selector: '.graph-topic-list button', orientation: 'both', activateOnFocus: false });
  const threadRuntime = useThreadRuntime();

  // Raw-ish per-node metadata (color, decay, degree) — cheap to (re)compute for the whole vault on
  // every poll; position lives in the graphology graph (see graphRef below), not here.
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
  // Hovered (mouse or keyboard-focused) node, from either the canvas or the topic list — the one
  // "what's highlighted" signal both surfaces read and write.
  const [focus, setFocus] = useState<string | null>(null);
  // 'pending' until the mount effect below resolves; 'fallback' means Sigma's import or
  // construction failed (no WebGL — true of every jsdom test, and of a real browser without it).
  const [canvasMode, setCanvasMode] = useState<'pending' | 'ready' | 'fallback'>('pending');
  const [teachAnchor, setTeachAnchor] = useState<{ x: number; y: number } | null>(null);
  const [misconceptionMarks, setMisconceptionMarks] = useState<
    Array<{ slug: string; x: number; y: number; text: string }>
  >([]);

  const reducedMotionRef = useRef<boolean>(
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );

  // Built once, lazily, DURING RENDER — graphology's own construction never touches WebGL, so
  // (unlike Sigma) there is no reason to defer it to an effect. It exists independent of whether
  // the canvas ever mounts: the fallback path still wants a queryable graph for focus/neighbour
  // bookkeeping, and building it once here (rather than re-creating it) is what lets syncGraph
  // update node positions IN PLACE across polls instead of resetting the layout every 30s.
  const graphRef = useRef<MasteryGraph | null>(null);
  if (graphRef.current === null) graphRef.current = new Graph();

  const colorsRef = useRef<GraphColors | null>(null);
  if (colorsRef.current === null) colorsRef.current = resolveGraphColors();

  const layoutRef = useRef<LayoutController | null>(null);
  const rendererRef = useRef<Sigma | null>(null);
  // Sigma's nodeReducer/edgeReducer settings are handed a bare function ONCE, at construction —
  // there is no call site to swap it out when `focus` changes. These wrapper closures have a
  // stable identity and just forward to whatever highlight.ts reducer is current in the ref, so a
  // focus change only has to update the ref and ask for a repaint, not tear down the renderer.
  const nodeReducerFnRef = useRef(nodeReducer(null, null, colorsRef.current.muted));
  const edgeReducerFnRef = useRef(edgeReducer(graphRef.current, null, colorsRef.current.muted));
  // Mirrors of state that event handlers registered once (in the mount effect) need to read
  // without becoming stale closures over a value that changes on every render.
  const selectedRef = useRef<string | null>(null);
  const focusRef = useRef<string | null>(null);
  // Cleared on every membership change (a different node set is a picture the learner has not
  // positioned yet, so auto-fit should run again); set by any real user pan/zoom so an auto-fit
  // never yanks the view out from under someone mid-inspection.
  const userAdjustedRef = useRef(false);
  const pendingFitRef = useRef(false);
  // Holds the mount effect's `doFit`, so the Fit button and the scope toggle (outside that effect)
  // can trigger it without depending on the renderer having mounted at all (before it has, or in
  // the fallback branch, the ref is null and the call is simply a no-op).
  const fitRef = useRef<((force: boolean) => void) | null>(null);

  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const canvasRefCallback = useCallback((el: HTMLDivElement | null) => setCanvasEl(el), []);

  useEffect(() => { selectedRef.current = selected; }, [selected]);

  // Recompute the highlight set whenever focus changes and ask the renderer to repaint with it.
  // Declared before the mount effect so its ref writes land before anything reads them the first
  // time a frame is drawn.
  useEffect(() => {
    focusRef.current = focus;
    const graph = graphRef.current!;
    const muted = colorsRef.current!.muted;
    const set = focusNeighbourhood(graph, focus);
    nodeReducerFnRef.current = nodeReducer(focus, set, muted);
    edgeReducerFnRef.current = edgeReducer(graph, set, muted);
    rendererRef.current?.refresh();
  }, [focus]);

  // ── Sigma mount (WebGL) ──────────────────────────────────────────────────
  // One Sigma instance per mount of the canvas container. Both `sigma` and nodeProgram.ts are
  // loaded lazily here (see the top-of-file comment) — an import OR constructor failure both mean
  // "no usable WebGL", and both route into the same fallback.
  useEffect(() => {
    const container = canvasEl;
    if (!container) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      let SigmaCtor: typeof Sigma;
      let MasteryNodeProgram: (typeof import('../graph/nodeProgram.js'))['MasteryNodeProgram'];
      try {
        const [sigmaMod, programMod] = await Promise.all([
          import('sigma'),
          import('../graph/nodeProgram.js'),
        ]);
        SigmaCtor = sigmaMod.default;
        MasteryNodeProgram = programMod.MasteryNodeProgram;
      } catch (err) {
        if (cancelled) return;
        console.error('[graph] WebGL unavailable:', err);
        setCanvasMode('fallback');
        return;
      }
      if (cancelled) return;

      const graph = graphRef.current!;
      const colors = colorsRef.current!;
      MasteryNodeProgram.warnColor = colors.warn;
      const labelFont = getComputedStyle(document.documentElement).getPropertyValue('--font-prose').trim() || 'system-ui';

      let renderer: Sigma;
      try {
        renderer = new SigmaCtor(graph, container, {
          nodeProgramClasses: { mastery: MasteryNodeProgram },
          defaultNodeType: 'mastery',
          renderEdgeLabels: false,
          zIndex: true,
          labelColor: { color: colors.label },
          labelFont,
          labelRenderedSizeThreshold: 6,
          labelDensity: 0.6,
          // sigma's own fit-to-frame (which the settle/Fit reset below drives via
          // camera.animatedReset) pads the CUSTOM bbox we hand it (getBBox() — node CENTRES only,
          // no radius or label width) by this many screen px. The default (30) left a node's own
          // label clipped at the canvas edge whenever that node sat near the bbox boundary — a
          // small contextual graph zooms in enough that 30px reads as almost nothing. 64px is
          // roughly a label's worth of breathing room at the sizes this graph actually renders.
          stagePadding: 64,
          allowInvalidContainer: true,
          nodeReducer: (node, data) => nodeReducerFnRef.current(node, data),
          edgeReducer: (edge, data) => edgeReducerFnRef.current(edge, data),
        });
      } catch (err) {
        if (cancelled) return;
        console.error('[graph] WebGL unavailable:', err);
        setCanvasMode('fallback');
        return;
      }
      if (cancelled) { renderer.kill(); return; }

      rendererRef.current = renderer;
      const layout = createLayout(graph, { reducedMotion: reducedMotionRef.current });
      layoutRef.current = layout;
      // Race with the [sub] sync effect below: that effect calls `layoutRef.current?.start()` on
      // every membership change, but sigma/nodeProgram are loaded here via a lazy, async import
      // (see this file's top-of-file comment) that can resolve AFTER the graph data fetch already
      // populated `graph` with its first batch of nodes — at that moment `layoutRef.current` was
      // still null, so that call was a silent no-op, and nothing re-invokes start() later purely
      // because the renderer finished mounting (a same-membership poll or mode toggle never calls
      // start() again — see that effect's own comment). Caught with a real 5,000-node fixture
      // (graph-perf.e2e.ts): when this race went the "wrong" way, the layout never ran at all until
      // a node drag's pin() incidentally started it — which read as a perf bug (a layout that
      // "never settles") but was actually a layout that never RAN. If nodes already arrived before
      // we got here, start it now instead of waiting on a membership change that may never come.
      if (graph.order > 0) layout.start();

      const camera = renderer.getCamera();
      const mouseCaptor = renderer.getMouseCaptor();

      // Distinguishes "we moved the camera to fit" from "the learner panned/zoomed" — camera
      // 'updated' fires for both, and only the second should ever set userAdjustedRef.
      let programmaticCameraMove = false;
      const onCameraUpdated = () => {
        if (!programmaticCameraMove) userAdjustedRef.current = true;
      };
      camera.on('updated', onCameraUpdated);

      const doFit = (force: boolean) => {
        if (graph.order === 0) return;
        if (userAdjustedRef.current && !force) return;
        // Freezes sigma's own auto-rescale to the frame computed HERE, so the layout settles
        // inside a fixed frame instead of the camera chasing every tick (see the plan's "why").
        renderer.setCustomBBox(renderer.getBBox());
        programmaticCameraMove = true;
        if (reducedMotionRef.current) {
          camera.setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
          programmaticCameraMove = false;
        } else {
          camera.animatedReset({ duration: FIT_ANIMATION_MS }).finally(() => { programmaticCameraMove = false; });
        }
        pendingFitRef.current = false;
        userAdjustedRef.current = false;
      };
      fitRef.current = doFit;

      const unsubscribeSettle = layout.onSettle(() => {
        savePositions(graph);
        if (pendingFitRef.current) doFit(true);
      });

      // Drag: pin the grabbed node under the cursor while the worker keeps running so neighbours
      // follow; release on mouseup. A release under 4px of total movement is a click instead,
      // matching the old d3-drag clickDistance(4) behaviour exactly.
      let dragging: { node: string; downX: number; downY: number; moved: boolean } | null = null;

      const onDownNode = (payload: SigmaNodeEventPayload) => {
        dragging = { node: payload.node, downX: payload.event.x, downY: payload.event.y, moved: false };
        payload.event.preventSigmaDefault();
      };
      const onMouseMoveBody = (coords: MouseCoords) => {
        if (!dragging) return;
        if (Math.hypot(coords.x - dragging.downX, coords.y - dragging.downY) >= 4) dragging.moved = true;
        const point = renderer.viewportToGraph(coords);
        layout.pin(dragging.node, point.x, point.y);
        coords.preventSigmaDefault();
        coords.original.preventDefault();
        coords.original.stopPropagation();
      };
      const onMouseUp = () => {
        if (!dragging) return;
        const { node, moved } = dragging;
        dragging = null;
        // Always release the pin — even a click that nudged the node under the 4px threshold must
        // not leave it fixed in place forever.
        layout.release(node);
        if (!moved) {
          setSelected(node);
          panelBus.openPage(node);
        }
      };
      const onEnterNode = (payload: SigmaNodeEventPayload) => setFocus(payload.node);
      const onLeaveNode = () => setFocus(null);

      renderer.on('downNode', onDownNode);
      renderer.on('enterNode', onEnterNode);
      renderer.on('leaveNode', onLeaveNode);
      mouseCaptor.on('mousemovebody', onMouseMoveBody);
      mouseCaptor.on('mouseup', onMouseUp);

      // The "Teach me this" button and misconception markers are HTML overlays (a WebGL canvas
      // can't host real, focusable/screen-readable DOM), repositioned every frame off the
      // renderer's own afterRender — the one hook guaranteed to fire after the camera/layout has
      // actually moved the pixels these overlays must track.
      const updateOverlays = () => {
        const sel = selectedRef.current;
        if (sel != null && graph.hasNode(sel)) {
          const attrs = graph.getNodeAttributes(sel);
          setTeachAnchor(renderer.graphToViewport({ x: attrs.x, y: attrs.y }));
        } else {
          setTeachAnchor(null);
        }
        const marks: Array<{ slug: string; x: number; y: number; text: string }> = [];
        graph.forEachNode((slug, attrs) => {
          if (attrs.misconceptions.length > 0) {
            const pos = renderer.graphToViewport({ x: attrs.x, y: attrs.y });
            marks.push({ slug, x: pos.x, y: pos.y, text: attrs.misconceptions.join('; ') });
          }
        });
        setMisconceptionMarks(marks);
      };
      renderer.on('afterRender', updateOverlays);

      cleanup = () => {
        camera.off('updated', onCameraUpdated);
        renderer.off('downNode', onDownNode);
        renderer.off('enterNode', onEnterNode);
        renderer.off('leaveNode', onLeaveNode);
        renderer.off('afterRender', updateOverlays);
        mouseCaptor.off('mousemovebody', onMouseMoveBody);
        mouseCaptor.off('mouseup', onMouseUp);
        unsubscribeSettle();
      };

      setCanvasMode('ready');
    })();

    return () => {
      cancelled = true;
      cleanup?.();
      fitRef.current = null;
      if (rendererRef.current) {
        savePositions(graphRef.current!);
        layoutRef.current?.kill();
        rendererRef.current.kill();
      }
      rendererRef.current = null;
      layoutRef.current = null;
    };
  }, [canvasEl]);

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

  // Feeds `sub` into the graphology graph: merges metadata into already-placed nodes IN PLACE
  // (positions untouched), spawns genuinely-new nodes near an already-placed neighbour, drops
  // nodes no longer in scope, and restarts the layout ONLY when membership actually changed. A
  // same-membership poll (the common case — metadata like decay/mastery colour can still change)
  // or a mode toggle back to an unchanged scope never restarts the layout, so it doesn't re-explode
  // on every 30s poll.
  useEffect(() => {
    const graph = graphRef.current!;
    const colors = colorsRef.current!;
    const { added, removed } = syncGraph(graph, sub, loadPositions(), {
      forceLabels: sub.nodes.length <= CONTEXT_CAP, colors,
    });
    if (focusRef.current != null && !graph.hasNode(focusRef.current)) setFocus(null);
    if (selectedRef.current != null && !graph.hasNode(selectedRef.current)) setSelected(null);
    if (added.length > 0 || removed.length > 0) {
      userAdjustedRef.current = false;
      pendingFitRef.current = true;
      layoutRef.current?.start();
    }
    const renderer = rendererRef.current;
    if (renderer) {
      // Scaled to the graph sigma is ACTUALLY drawing right now, not `mode` — "Whole vault" on a
      // 17-node test vault should stay in the cheap/dense-off path, and a future large contextual
      // cap should still get the perf settings it needs.
      const large = graph.order > LARGE_GRAPH_NODES;
      renderer.setSetting('hideEdgesOnMove', large);
      renderer.setSetting('hideLabelsOnMove', large);
      const dense = sub.nodes.length > CONTEXT_CAP;
      renderer.setSetting('labelDensity', dense ? DENSE_LABEL_DENSITY : 0.6);
      renderer.setSetting('labelGridCellSize', dense ? DENSE_LABEL_GRID_CELL_SIZE : 100);
      renderer.refresh();
    }
  }, [sub]);

  const seedTitle = mode === 'contextual' && sub.seedSlug != null
    ? (meta.nodes.find((n) => n.slug === sub.seedSlug)?.title ?? sub.seedSlug) : null;

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
          {/* Scope switches re-fit: the two scopes have wildly different extents, and the audit
              found "Whole vault" leaving most of a 17-node vault outside the viewport until the
              learner discovered the separate fit button. A short delay lets the layout spread
              before framing it. */}
          <button type="button" role="tab" aria-selected={mode === 'contextual'}
            tabIndex={mode === 'contextual' ? 0 : -1}
            className={mode === 'contextual' ? 'on' : ''}
            onClick={() => { setMode('contextual'); setTimeout(() => fitRef.current?.(true), 350); }}>
            This topic
          </button>
          <button type="button" role="tab" aria-selected={mode === 'full'}
            tabIndex={mode === 'full' ? 0 : -1}
            className={mode === 'full' ? 'on' : ''}
            onClick={() => { setMode('full'); setTimeout(() => fitRef.current?.(true), 350); }}>
            Whole vault
          </button>
        </div>
        {/* Outside the tablist on purpose: it is an action, not a third scope, and putting a
            non-tab button inside role="tablist" would break the tab semantics for a screen reader.
            `force` because this is the one place an explicit re-fit should override the
            user-adjusted guard. */}
        <div className="graph-actions">
          <button type="button" className="ghost-btn graph-fit" onClick={() => fitRef.current?.(true)}>
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
        // Cold start: an empty vault rendered an empty canvas under a full mastery legend — a key
        // to nothing, and no indication that the way to fill it is to go and ask. This is the
        // FIRST thing a new learner sees, and the north star is "help someone learn anything",
        // which begins with nothing in the vault.
        <p className="graph-subtitle graph-empty" role="status">
          Nothing in the graph yet. Ask your tutor about anything you want to learn — pages and the
          links between them are written as you go.
        </p>
      ) : loadError ? (
        <p className="graph-subtitle hint graph-error" role="status">
          {loadError} The graph will reappear on its own once it loads.
        </p>
      ) : (
        <div className="graph-canvas-wrap">
          {/* aria-hidden: the canvas is a WebGL surface, not a DOM tree — a screen reader has
              nothing here to read and nothing here to focus. The topic list below is the real
              keyboard/screen-reader surface for this data. */}
          <div ref={canvasRefCallback} className="graph-canvas" aria-hidden="true" />
          {canvasMode === 'fallback' && (
            <p className="graph-subtitle graph-error" role="status">
              graph view needs WebGL — showing the topic list instead
            </p>
          )}
          {canvasMode === 'ready' && selected != null && teachAnchor != null && (
            <button type="button" className="graph-overlay graph-teach"
              style={{ left: teachAnchor.x, top: teachAnchor.y }}
              onClick={() => threadRuntime.append(`Teach me ${selected} now`)}>
              Teach me this
            </button>
          )}
          {canvasMode === 'ready' && misconceptionMarks.map((m) => (
            <span key={m.slug} className="graph-overlay graph-misconception" aria-hidden="true"
              style={{ left: m.x, top: m.y }} title={m.text}>
              <Warning size={14} weight="bold" color="var(--bad)" />
            </span>
          ))}
        </div>
      )}
      {!loading && !loadError && sub.nodes.length > 0 && (
        <section className="graph-topic-list" aria-label="Topics in this view">
          <h3>Topics in this view</h3>
          {sub.edges.length === 0 && <p>No connections in this view yet. Open a topic to read its notes.</p>}
          <ul onKeyDown={onTopicKeys}>{sub.nodes.map((n, nodeIndex) => (
            <li key={n.slug}>
              <button type="button" aria-label={`Open ${n.title}, ${factsFor(n)}`}
                tabIndex={(selected != null ? selected === n.slug : nodeIndex === 0) ? 0 : -1}
                onFocus={() => setFocus(n.slug)}
                onBlur={() => setFocus((f) => (f === n.slug ? null : f))}
                onMouseEnter={() => setFocus(n.slug)}
                onMouseLeave={() => setFocus((f) => (f === n.slug ? null : f))}
                onClick={() => { setSelected(n.slug); panelBus.openPage(n.slug); }}>
                <span>{n.title}</span>
                <span className="graph-topic-standing">{n.effective}{n.slipped ? ' · due for review' : ''}</span>
              </button>
            </li>
          ))}</ul>
        </section>
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
        <span><i className="ring slipping" /> slipping</span>
        <span><Warning size={12} weight="bold" color="var(--bad)" aria-hidden /> misconception</span>
      </div>
      )}
    </div>
  );
}
