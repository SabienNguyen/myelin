import {
  memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type Dispatch, type KeyboardEvent, type SetStateAction,
} from 'react';
import { useThreadRuntime } from '@assistant-ui/react';
// sigma's bundle reads WebGLRenderingContext/WebGL2RenderingContext constants AT MODULE LOAD (see
// tests/client/nodeProgram.test.ts's comment) — a static `import Sigma from 'sigma'` would make
// THIS FILE throw on import in jsdom and in any browser without WebGL. Only `import type` here;
// the mount effect below loads the real module (and nodeProgram.ts, which has the same problem)
// lazily and routes a failure into the WebGL-unavailable fallback.
import type Sigma from 'sigma';
import type { MouseCoords, SigmaNodeEventPayload, TouchCoords } from 'sigma/types';
import { WarningIcon as Warning } from '@phosphor-icons/react';
import { MultiDirectedGraph as Graph } from 'graphology';
import { ChatStoreContext } from '../chatCore/index.js';
import { pagesTouched } from '../../shared/topics.js';
import { getGraph } from '../lib/api.js';
import { LEVEL_LABEL, type MasteryLevel } from '../lib/mastery.js';
import { useRovingKeys, useTablistKeys } from '../lib/tablist.js';
import { graphMeta, type GraphNodeMeta, type LaidOutEdge } from '../lib/graphLayout.js';
import { panelBus } from '../lib/panelBus.js';
import { parseHash } from '../lib/urlState.js';
import { useConversationNotebook } from './Notebooks.js';
import {
  densityScale, resolveGraphColors, syncGraph, type MasteryGraph, type GraphColors,
} from '../graph/buildGraph.js';
import { makeLabelDrawer } from '../graph/labels.js';
import { createLayout, type LayoutController } from '../graph/layout.js';
import { createNodeDrag } from '../graph/nodeDrag.js';
import { loadPositions, savePositions } from '../graph/positionStore.js';
import { focusNeighbourhood, hoverLabelled, nodeReducer, edgeReducer } from '../graph/highlight.js';

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
// Labels not forced on (see labelsFor) go through sigma's label grid, which skips a label that would
// collide. A 400-node whole-vault screenshot showed labels overlapping each other in the dense
// centre at the default labelDensity/labelGridCellSize — fewer, larger grid cells thin that out.
const DENSE_LABEL_DENSITY = 0.35;
const DENSE_LABEL_GRID_CELL_SIZE = 140;
// Forced labels are drawn whether or not they collide. Every label forced on in a 27-page topic
// view piled a dozen titles on top of each other in its core, so past this size only the topic and
// its direct links are forced; hovering a node labels it and its best-linked neighbours.
const ALL_LABELS_UP_TO = 12;
// On a canvas this short (a phone's 338x160, a 600px-tall laptop window) even a dozen forced labels
// pile onto one blob, so only the topic and its direct links are forced there.
const COMPACT_CANVAS_PX = 250;

function labelsFor(sub: Subgraph<GraphNodeMeta>, compact: boolean): boolean | ReadonlySet<string> {
  if (sub.nodes.length <= ALL_LABELS_UP_TO && !compact) return true;
  if (sub.nodes.length > CONTEXT_CAP || sub.seedSlug == null) return false;
  return new Set([sub.seedSlug, ...neighborSlugs(sub.seedSlug, sub.edges)]);
}

/** sigma pads the fitted bbox (node centres only, no radius or label width) by this many screen px
 *  on every side. 64 is roughly a label's worth of room on a desktop canvas; on a phone's 160px-tall
 *  one it left a 32px band for the whole graph, so it shrinks with the canvas's shorter side. */
export function stagePaddingFor(width: number, height: number): number {
  return Math.min(64, Math.round(0.15 * Math.min(width, height)));
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
// At or below this many pages the canvas keeps its 260px cap and the topic list takes the room (see
// .graph-panel.is-sparse in styles.css): a tall canvas around one or two dots is empty space.
const SPARSE_NODES = 3;

/** The notebook scope: only the pages a notebook covers, and only the links between them — the
 *  map of one subject, the way the notebook's own topic list is its outline. Pure. */
export function notebookSubgraph<N extends ContextualNode>(
  nodes: N[], edges: LaidOutEdge[], slugs: readonly string[],
): Subgraph<N> {
  const inScope = new Set(slugs);
  return {
    nodes: nodes.filter((n) => inScope.has(n.slug)),
    edges: edges.filter((e) => inScope.has(e.src) && inScope.has(e.dst)),
    seedSlug: null, seedInferred: false, hops: 0, truncated: false,
  };
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

/** The accessible name suffix for a topic-list button — the same facts the old SVG node's
 * aria-label carried (mastery+decay had no other home once the canvas became aria-hidden), so a
 * screen-reader user loses nothing by the canvas no longer being their interaction surface. */
function factsFor(n: GraphNodeMeta): string {
  const facts: string[] = [LEVEL_LABEL[n.effective]];
  if (n.daysLeft != null) facts.push(`${n.daysLeft} ${n.daysLeft === 1 ? 'day' : 'days'} until decay`);
  if (n.slipped) facts.push('slipping — due for review');
  if (n.misconceptions.length > 0) facts.push('has a recorded misconception');
  return facts.join(', ');
}

const FIT_ANIMATION_MS = 300;

// Past this many rows the topic list stops being a list anyone scans (a 5,000-page whole vault was
// tens of thousands of DOM nodes); it shows the pages most due for review and points at search.
export const TOPIC_LIST_CAP = 200;

/** Slipping pages first, then the nearest decay, then pages with no decay clock; stable otherwise. */
function dueFirst(nodes: GraphNodeMeta[]): GraphNodeMeta[] {
  const urgency = (n: GraphNodeMeta) => (n.slipped ? -1 : n.daysLeft ?? Infinity);
  return [...nodes].sort((a, b) => urgency(a) - urgency(b));
}

interface TopicListProps {
  nodes: GraphNodeMeta[];
  hasEdges: boolean;
  selected: string | null;
  onKeys: (e: KeyboardEvent<Element>) => void;
  onFocusTopic: Dispatch<SetStateAction<string | null>>;
  onOpen: (slug: string) => void;
}

// Memoized, with only stable callbacks passed in: GraphPanel re-renders on every canvas hover (the
// `focus` state), and on a whole vault this list is one button per page — re-rendering 5,000 of
// them per hover cost more than the highlight it accompanied.
const TopicList = memo(function TopicList({
  nodes, hasEdges, selected, onKeys, onFocusTopic, onOpen,
}: TopicListProps) {
  const shown = useMemo(
    () => (nodes.length > TOPIC_LIST_CAP ? dueFirst(nodes).slice(0, TOPIC_LIST_CAP) : nodes),
    [nodes],
  );
  return (
    <section className="graph-topic-list" aria-label="Topics in this view">
      <h3>Topics in this view</h3>
      {!hasEdges && <p>No connections in this view yet. Open a topic to read its notes.</p>}
      {shown.length < nodes.length && (
        <p>
          The {shown.length} most due of {nodes.length} pages. Find any other with the page search
          (Ctrl K, ⌘K on a Mac), or open one and switch to This topic.
        </p>
      )}
      <ul onKeyDown={onKeys}>{shown.map((n, nodeIndex) => (
        <li key={n.slug}>
          <button type="button" aria-label={`Open ${n.title}, ${factsFor(n)}`}
            tabIndex={(selected != null ? selected === n.slug : nodeIndex === 0) ? 0 : -1}
            onFocus={() => onFocusTopic(n.slug)}
            onBlur={() => onFocusTopic((f) => (f === n.slug ? null : f))}
            onMouseEnter={() => onFocusTopic(n.slug)}
            onMouseLeave={() => onFocusTopic((f) => (f === n.slug ? null : f))}
            onClick={() => onOpen(n.slug)}>
            <span>{n.title}</span>
            <span className="graph-topic-standing">{LEVEL_LABEL[n.effective]}{n.slipped ? ' · due for review' : ''}</span>
          </button>
        </li>
      ))}</ul>
    </section>
  );
});

type Scope = 'contextual' | 'notebook' | 'full';

const noSubscribe = () => () => {};

// Least to most learned, the way the node fills read.
const LEGEND_LEVELS: readonly MasteryLevel[] = ['unseen', 'exposed', 'practicing', 'mastered'];

export function GraphPanel({ visible = true }: { visible?: boolean }) {
  const onScopeKeys = useTablistKeys();
  const onTopicKeys = useRovingKeys({ selector: '.graph-topic-list button', orientation: 'both', activateOnFocus: false });
  const threadRuntime = useThreadRuntime();

  // Raw-ish per-node metadata (color, decay, degree) — cheap to (re)compute for the whole vault on
  // every poll; position lives in the graphology graph (see graphRef below), not here.
  const [meta, setMeta] = useState<{ nodes: GraphNodeMeta[]; edges: LaidOutEdge[] }>({ nodes: [], edges: [] });
  // The last /api/graph nodes, for recomputing colours on a scheme change, and a fingerprint of
  // them: a poll that brings the same payload skips setMeta, whose new arrays would re-render the
  // memoized topic list (every row, on a whole vault) twice a minute for nothing.
  const rawRef = useRef<unknown[] | null>(null);
  const fingerprintRef = useRef<string | null>(null);
  // True until the FIRST fetch+layout has resolved. Gates the "laying out the graph…" placeholder
  // so a student switching to the Graph tab sees that instead of a misleading "open a page to
  // focus" hint or a blank canvas. A plain `let firstLoad` flag inside the load effect (rather than
  // resetting this state elsewhere) means subsequent poll refreshes never flip it back to true.
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // null until the learner picks a scope; see `mode` below for what shows until then.
  const [chosenMode, setChosenMode] = useState<Scope | null>(null);
  // The open conversation's notebook, when it has one: offers a third scope between one topic's
  // neighbourhood and the whole vault. GraphPanel remounts with each conversation (Runtime is
  // keyed by thread), so reading the hash once is enough.
  const notebook = useConversationNotebook(parseHash(location.hash).threadId);
  // The notebook's topics are read once, when the conversation opens. A page this conversation
  // writes afterwards is in the notebook too, so it joins from the conversation's own tool calls
  // instead of waiting for a remount. A joined string, so the store's per-token updates re-render
  // only when the set of pages changes.
  const chatStore = useContext(ChatStoreContext);
  const touchedKey = useSyncExternalStore(chatStore?.subscribe ?? noSubscribe, () => {
    const state = chatStore?.getState();
    return state ? pagesTouched(state.messages).join('\n') : '';
  });
  const notebookSlugs = useMemo(() => {
    if (!notebook || !Array.isArray(notebook.topics)) return null;
    const touched = touchedKey ? touchedKey.split('\n') : [];
    return [...new Set([...notebook.topics.map((t) => t.slug), ...touched])];
  }, [notebook, touchedKey]);
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
  // Bumped when a lost WebGL context is restored: sigma cannot rebuild its programs on a new
  // context, so the renderer is mounted again from scratch.
  const [mountKey, setMountKey] = useState(0);
  // Bumped when the OS colour scheme or contrast preference changes; see the effect that reads it.
  const [scheme, setScheme] = useState(0);
  // The canvas's shorter side is under COMPACT_CANVAS_PX (see labelsFor).
  const [compact, setCompact] = useState(false);
  // The HTML overlays' POSITIONS never pass through React state. They follow the camera, so they
  // change on every sigma frame, and a setState per frame re-rendered this whole panel (topic list
  // included) while panning: ~25ms of React work per frame at 5,000 pages, measured with a CPU
  // profile of graph-perf.e2e.ts's pan — over budget before the canvas drew anything. React decides
  // WHICH overlays exist; placeOverlaysRef writes where they sit, straight to their style.
  const teachRef = useRef<HTMLButtonElement | null>(null);
  const markEls = useRef(new Map<string, HTMLElement>());
  const placeOverlaysRef = useRef<(() => void) | null>(null);

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
  // The lazily loaded node program class, whose static warnColor a scheme change updates.
  const programRef = useRef<(typeof import('../graph/nodeProgram.js'))['MasteryNodeProgram'] | null>(null);
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
  // A scope tab was chosen: the next membership sync refits (see fitScope).
  const scopeFitRef = useRef(false);
  // Holds the mount effect's `doFit`, so the Fit button and the scope toggle (outside that effect)
  // can trigger it without depending on the renderer having mounted at all (before it has, or in
  // the fallback branch, the ref is null and the call is simply a no-op).
  const fitRef = useRef<((force: boolean) => void) | null>(null);

  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const canvasRefCallback = useCallback((el: HTMLDivElement | null) => setCanvasEl(el), []);

  // A layout effect so the overlay placement below (also a layout effect, declared later) reads the
  // new selection rather than the one before it — passive effects run after every layout effect.
  useLayoutEffect(() => { selectedRef.current = selected; }, [selected]);

  // The canvas's colours are resolved from CSS tokens into strings once, so an OS switch to light
  // at sunrise left dark-scheme labels (near-white) on the light canvas until a reload. On a scheme
  // or contrast change: resolve again, hand sigma the new label and ring colours, and recompute the
  // node metadata, whose new fills (and, through syncGraph, edge colours) the membership sync below
  // writes into the graph. The reducers pick the new muted colour up in the focus effect after this.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const queries = ['(prefers-color-scheme: dark)', '(prefers-contrast: more)'].map((q) => window.matchMedia(q));
    const onChange = () => setScheme((v) => v + 1);
    for (const q of queries) q.addEventListener('change', onChange);
    return () => { for (const q of queries) q.removeEventListener('change', onChange); };
  }, []);
  useEffect(() => {
    if (scheme === 0) return;
    const colors = resolveGraphColors();
    colorsRef.current = colors;
    if (programRef.current) programRef.current.warnColor = colors.warn;
    rendererRef.current?.setSetting('labelColor', { color: colors.label });
    if (rawRef.current) setMeta(graphMeta(rawRef.current, new Date()));
  }, [scheme]);

  // Recompute the highlight set whenever focus changes and ask the renderer to repaint with it.
  // Declared before the mount effect so its ref writes land before anything reads them the first
  // time a frame is drawn.
  useEffect(() => {
    focusRef.current = focus;
    const graph = graphRef.current!;
    const muted = colorsRef.current!.muted;
    const set = focusNeighbourhood(graph, focus);
    nodeReducerFnRef.current = nodeReducer(focus, set, muted, hoverLabelled(graph, focus, set));
    edgeReducerFnRef.current = edgeReducer(graph, set, muted);
    rendererRef.current?.refresh();
  }, [focus, scheme]);

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
      let program: typeof import('../graph/nodeProgram.js');
      try {
        const [sigmaMod, programMod] = await Promise.all([
          import('sigma'),
          import('../graph/nodeProgram.js'),
        ]);
        SigmaCtor = sigmaMod.default;
        program = programMod;
      } catch (err) {
        if (cancelled) return;
        console.error('[graph] WebGL unavailable:', err);
        setCanvasMode('fallback');
        return;
      }
      if (cancelled) return;

      const graph = graphRef.current!;
      const { MasteryNodeProgram } = program;
      MasteryNodeProgram.warnColor = colorsRef.current!.warn;
      programRef.current = MasteryNodeProgram;
      const labelFont = getComputedStyle(document.documentElement).getPropertyValue('--font-prose').trim() || 'system-ui';

      let renderer: Sigma;
      try {
        renderer = new SigmaCtor(graph, container, {
          nodeProgramClasses: { mastery: MasteryNodeProgram },
          defaultNodeType: 'mastery',
          renderEdgeLabels: false,
          zIndex: true,
          labelColor: { color: colorsRef.current!.label },
          labelFont,
          labelRenderedSizeThreshold: 6,
          labelDensity: 0.6,
          // Kept in step with the canvas size by onResize below; see stagePaddingFor.
          stagePadding: stagePaddingFor(container.offsetWidth, container.offsetHeight),
          // Colour and canvas width are read at draw time, so a scheme change or a resize applies
          // without rebuilding the renderer. Both drawers share the same canvas-width getter so the
          // hover box and the fitted label always agree on which side has room.
          defaultDrawNodeHover: program.themedNodeHover(
            () => ({ fill: colorsRef.current!.background, stroke: colorsRef.current!.border }),
            () => rendererRef.current?.getDimensions().width ?? container.clientWidth,
          ),
          defaultDrawNodeLabel: makeLabelDrawer(
            () => colorsRef.current!.label,
            () => rendererRef.current?.getDimensions().width ?? container.clientWidth,
          ),
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
      // Read when it is needed (doFit) and followed live (the layout), not once at mount: turning on
      // reduce motion mid-session left fits animating until a reload.
      const motionQuery = typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      const layout = createLayout(graph, {
        reducedMotion: motionQuery?.matches === true,
        aspect: () => (container.offsetHeight > 0 ? container.offsetWidth / container.offsetHeight : 1),
      });
      layoutRef.current = layout;
      const onMotionChange = () => layout.setReducedMotion(prefersReducedMotion());
      motionQuery?.addEventListener('change', onMotionChange);
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
      const touchCaptor = renderer.getTouchCaptor();

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
        // getBBox is the extent the last process() computed, and setCustomBBox only schedules a
        // render: the normalisation is rebuilt in process(), which only refresh() runs. So the
        // custom box is cleared and the graph processed first, or a settled graph kept its stale
        // frame and fit did nothing (Whole vault left a subject off the canvas until the next poll).
        renderer.setCustomBBox(null);
        renderer.refresh();
        renderer.setCustomBBox(renderer.getBBox());
        programmaticCameraMove = true;
        if (motionQuery?.matches) {
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

      // Drag pins the grabbed node under the pointer while the worker keeps running so neighbours
      // follow; a click or tap opens the page (nodeDrag.ts). Mouse moves come from the mouse captor
      // and one-finger moves from the touch captor; sigma's upNode/upStage end a press of either.
      const drag = createNodeDrag({
        hasNode: (node) => graph.hasNode(node),
        toGraph: (p) => renderer.viewportToGraph(p),
        pin: (node, x, y) => layout.pin(node, x, y),
        release: (node) => layout.release(node),
        open: (node) => {
          setSelected(node);
          panelBus.openPage(node);
        },
      });
      const onDownNode = (payload: SigmaNodeEventPayload) => {
        drag.down(payload.node, payload.event.x, payload.event.y);
        payload.event.preventSigmaDefault();
      };
      const onMouseMoveBody = (coords: MouseCoords) => {
        if (!drag.move(coords.x, coords.y)) return;
        coords.preventSigmaDefault();
        coords.original.preventDefault();
        coords.original.stopPropagation();
      };
      // Two fingers are a pinch, which stays sigma's.
      const onTouchMove = (coords: TouchCoords) => {
        if (coords.touches.length !== 1 || !drag.move(coords.touches[0].x, coords.touches[0].y)) return;
        coords.preventSigmaDefault();
      };
      const onUp = () => drag.up();
      const onClickNode = (payload: SigmaNodeEventPayload) => drag.click(payload.node);
      const onEnterNode = (payload: SigmaNodeEventPayload) => setFocus(payload.node);
      const onLeaveNode = () => setFocus(null);

      renderer.on('downNode', onDownNode);
      renderer.on('upNode', onUp);
      renderer.on('upStage', onUp);
      renderer.on('clickNode', onClickNode);
      renderer.on('enterNode', onEnterNode);
      renderer.on('leaveNode', onLeaveNode);
      mouseCaptor.on('mousemovebody', onMouseMoveBody);
      touchCaptor.on('touchmove', onTouchMove);

      const onResize = () => {
        const width = container.offsetWidth;
        const height = container.offsetHeight;
        const padding = stagePaddingFor(width, height);
        if (renderer.getSetting('stagePadding') !== padding) renderer.setSetting('stagePadding', padding);
        setCompact(Math.min(width, height) < COMPACT_CANVAS_PX);
      };
      onResize();
      const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
      resizeObserver?.observe(container);

      // A GPU reset or a mobile tab eviction loses the contexts and the canvas goes blank.
      // preventDefault asks the browser to restore them; the topic list stands in until it does,
      // and the restore mounts a fresh renderer (mountKey), since sigma's programs die with the
      // context. Capture phase: the events fire on sigma's canvases and do not bubble.
      let contextLost = false;
      const onContextLost = (e: Event) => {
        e.preventDefault();
        if (contextLost) return;
        contextLost = true;
        console.error('[graph] WebGL context lost, showing the topic list until it is restored');
        setCanvasMode('fallback');
      };
      const onContextRestored = () => {
        if (!contextLost) return;
        contextLost = false;
        setMountKey((k) => k + 1);
      };
      container.addEventListener('webglcontextlost', onContextLost, true);
      container.addEventListener('webglcontextrestored', onContextRestored, true);

      // The "Teach me this" button and misconception markers are HTML overlays (a WebGL canvas
      // can't host real, focusable/screen-readable DOM), repositioned off the renderer's own
      // afterRender — the one hook guaranteed to fire after the camera/layout has actually moved
      // the pixels these overlays must track. `visibility`, not the `hidden` attribute: the
      // stylesheet gives .graph-misconception an explicit display, which beats hidden's UA rule.
      const inFrame = (slug: string): { x: number; y: number; visible: boolean } => {
        const { width, height } = renderer.getDimensions();
        const attrs = graph.getNodeAttributes(slug);
        const { x, y } = renderer.graphToViewport({ x: attrs.x, y: attrs.y });
        return { x, y, visible: x >= 0 && y >= 0 && x <= width && y <= height };
      };
      const placeOverlays = () => {
        const place = (el: HTMLElement, slug: string) => {
          if (!graph.hasNode(slug)) { el.style.visibility = 'hidden'; return; }
          const { x, y, visible } = inFrame(slug);
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
          el.style.visibility = visible ? '' : 'hidden';
        };
        const sel = selectedRef.current;
        if (teachRef.current && sel != null) place(teachRef.current, sel);
        for (const [slug, el] of markEls.current) place(el, slug);
      };
      placeOverlaysRef.current = placeOverlays;
      renderer.on('afterRender', placeOverlays);

      // The e2e suite cannot look inside a WebGL canvas. Under automation (Playwright sets
      // navigator.webdriver) it reads how many nodes are placed on screen and whether the layout
      // still runs, so a graph that draws nothing fails a test instead of passing it.
      const testWindow = window as unknown as { __myelinGraph?: unknown };
      if (navigator.webdriver) {
        testWindow.__myelinGraph = {
          get order() { return graph.order; },
          get finite() {
            let placed = 0;
            graph.forEachNode((slug, a) => {
              if (Number.isFinite(a.x) && Number.isFinite(a.y) && inFrame(slug).visible) placed += 1;
            });
            return placed;
          },
          get running() { return layout.isRunning(); },
        };
      }

      cleanup = () => {
        camera.off('updated', onCameraUpdated);
        renderer.off('downNode', onDownNode);
        renderer.off('upNode', onUp);
        renderer.off('upStage', onUp);
        renderer.off('clickNode', onClickNode);
        renderer.off('enterNode', onEnterNode);
        renderer.off('leaveNode', onLeaveNode);
        renderer.off('afterRender', placeOverlays);
        mouseCaptor.off('mousemovebody', onMouseMoveBody);
        touchCaptor.off('touchmove', onTouchMove);
        motionQuery?.removeEventListener('change', onMotionChange);
        resizeObserver?.disconnect();
        container.removeEventListener('webglcontextlost', onContextLost, true);
        container.removeEventListener('webglcontextrestored', onContextRestored, true);
        delete testWindow.__myelinGraph;
        unsubscribeSettle();
      };

      setCanvasMode('ready');
    })();

    return () => {
      cancelled = true;
      cleanup?.();
      fitRef.current = null;
      placeOverlaysRef.current = null;
      if (rendererRef.current) {
        savePositions(graphRef.current!);
        layoutRef.current?.kill();
        rendererRef.current.kill();
      }
      rendererRef.current = null;
      layoutRef.current = null;
    };
  }, [canvasEl, mountKey]);

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
        const nodes: unknown[] = data.nodes ?? [];
        // The hour is in it because graphMeta's decay rings also move with the clock.
        const fingerprint = `${Math.floor(Date.now() / 3_600_000)}\n${JSON.stringify(nodes)}`;
        if (fingerprint !== fingerprintRef.current) {
          fingerprintRef.current = fingerprint;
          rawRef.current = nodes;
          setMeta(graphMeta(nodes, new Date()));
        }
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
  const notebookSub = useMemo(
    () => (notebookSlugs ? notebookSubgraph(meta.nodes, meta.edges, notebookSlugs) : null),
    [meta, notebookSlugs],
  );
  // Offered only with a page in the graph: a notebook whose only topic is an untouched stub (which
  // /api/graph hides), or a page newer than the graph cache, is an empty scope, and an empty scope
  // read as an empty vault and hid the other scope tabs.
  const notebookOffered = notebookSub != null && notebookSub.nodes.length > 0;
  // Until the learner picks a scope, a notebook conversation with no page open shows its notebook:
  // the contextual seed would otherwise be a guess from decay data (the vault's most recently
  // studied page), often in another subject entirely.
  const guessedSeed = contextualSub.seedSlug == null || contextualSub.seedInferred;
  const mode: Scope = chosenMode === 'notebook' && !notebookOffered
    ? 'contextual'
    : chosenMode ?? (notebookOffered && guessedSeed ? 'notebook' : 'contextual');
  const sub = mode === 'contextual' ? contextualSub : mode === 'notebook' ? notebookSub! : fullSub;

  // A scope switch refits: the scopes have wildly different extents. While the layout runs the fit
  // waits for its settle; framing mid-run froze the frame with a subject still drifting outside it.
  const fitScope = () => {
    userAdjustedRef.current = false;
    if (layoutRef.current?.isRunning()) pendingFitRef.current = true;
    else fitRef.current?.(true);
  };
  const chooseScope = (next: Scope) => {
    setChosenMode(next);
    // The same scope again changes no membership, so no sync runs to fit it.
    if (next === mode) fitScope();
    else scopeFitRef.current = true;
  };

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
      forceLabels: labelsFor(sub, compact), colors,
      sizeScale: densityScale(sub.nodes.length, CONTEXT_CAP),
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
    if (scopeFitRef.current) {
      scopeFitRef.current = false;
      fitScope();
    }
  }, [sub, compact]);

  const marked = useMemo(() => sub.nodes.filter((n) => n.misconceptions.length > 0), [sub]);
  // A newly mounted overlay has no position until something places it, and sigma only fires
  // afterRender when it draws — selecting a node on a settled graph draws nothing.
  useLayoutEffect(() => { placeOverlaysRef.current?.(); }, [selected, marked, canvasMode]);

  const openTopic = useCallback((slug: string) => {
    setSelected(slug);
    panelBus.openPage(slug);
  }, []);

  const seedTitle = mode === 'contextual' && sub.seedSlug != null
    ? (meta.nodes.find((n) => n.slug === sub.seedSlug)?.title ?? sub.seedSlug) : null;

  // `hidden` alone does nothing here: the attribute's UA rule is `display: none`, which any explicit
  // `display` in the stylesheet beats — and .graph-controls is `display: flex`. Keep the attribute
  // for semantics and add the class the stylesheet actually acts on. Keyed on the vault, not the
  // scope, and never over a load error: neither is an empty vault.
  const controlsHidden = !loading && !loadError && meta.nodes.length === 0;

  return (
    <div className={`graph-panel${sub.nodes.length <= SPARSE_NODES ? ' is-sparse' : ''}`}>
      {/* The whole control row is hidden on an empty vault: a scope toggle with nothing to scope
          and a "fit" button with nothing to fit are just noise in front of the one sentence that
          tells a new learner what to do. */}
      <div className={`graph-controls${controlsHidden ? ' is-hidden' : ''}`} hidden={controlsHidden}>
        <div className="graph-row">
        <div className="graph-mode-toggle" role="tablist" aria-label="Graph scope" onKeyDown={onScopeKeys}>
          <button type="button" role="tab" aria-selected={mode === 'contextual'}
            tabIndex={mode === 'contextual' ? 0 : -1}
            className={mode === 'contextual' ? 'on' : ''}
            onClick={() => chooseScope('contextual')}>
            This topic
          </button>
          {notebook && notebookOffered && (
            <button type="button" role="tab" aria-selected={mode === 'notebook'}
              tabIndex={mode === 'notebook' ? 0 : -1}
              className={mode === 'notebook' ? 'on' : ''}
              title={notebook.notebook.title}
              onClick={() => chooseScope('notebook')}>
              This notebook
            </button>
          )}
          <button type="button" role="tab" aria-selected={mode === 'full'}
            tabIndex={mode === 'full' ? 0 : -1}
            className={mode === 'full' ? 'on' : ''}
            onClick={() => chooseScope('full')}>
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
        {!loading && mode === 'notebook' && notebook && (
          <p className="graph-subtitle">
            {notebook.notebook.title} · {sub.nodes.length} {sub.nodes.length === 1 ? 'page' : 'pages'}
            {sub.nodes.length > 1 && sub.edges.length === 0 && ' · no links between them yet'}
          </p>
        )}
        {!loading && mode === 'contextual' && (
          seedTitle != null ? (
            <p className="graph-subtitle">
              around {seedTitle}{sub.seedInferred && ' (last studied)'} · {sub.hops} hops
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
      ) : loadError ? (
        <p className="graph-subtitle hint graph-error" role="status">
          {loadError} The graph will reappear on its own once it loads.
        </p>
      ) : sub.nodes.length === 0 ? (
        // Cold start: an empty vault rendered an empty canvas under a full mastery legend — a key
        // to nothing, and no indication that the way to fill it is to go and ask. This is the
        // FIRST thing a new learner sees, and the north star is "help someone learn anything",
        // which begins with nothing in the vault.
        <p className="graph-subtitle graph-empty" role="status">
          Nothing in the graph yet. Ask your tutor about anything you want to learn — pages and the
          links between them are written as you go.
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
          {canvasMode === 'ready' && selected != null && (
            <button type="button" ref={teachRef} className="graph-overlay graph-teach"
              onClick={() => threadRuntime.append(`Teach me ${selected} now`)}>
              Teach me this
            </button>
          )}
          {canvasMode === 'ready' && marked.map((n) => (
            <span key={n.slug} className="graph-overlay graph-misconception" aria-hidden="true"
              title={n.misconceptions.join('; ')}
              ref={(el) => {
                if (!el) return undefined;
                markEls.current.set(n.slug, el);
                return () => { markEls.current.delete(n.slug); };
              }}>
              <Warning size={14} weight="bold" color="var(--bad)" />
            </span>
          ))}
        </div>
      )}
      {!loading && !loadError && sub.nodes.length > 0 && (
        <TopicList nodes={sub.nodes} hasEdges={sub.edges.length > 0} selected={selected}
          onKeys={onTopicKeys} onFocusTopic={setFocus} onOpen={openTopic} />
      )}
      {/* Also gated on loadError: a mastery legend under an error message is a key to a graph that
          is not there. */}
      {!loading && !loadError && sub.nodes.length > 0 && (
      <div className="graph-legend">
        {/* var(--mastery-*), not literal hex: the tokens in styles.css are the single source these
            swatches and lib/graphLayout.ts's node fills both read, so the legend can no longer
            disagree with the graph it describes, and both follow the colour scheme. */}
        {LEGEND_LEVELS.map((level) => (
          <span key={level}><i className="dot" style={{ background: `var(--mastery-${level})` }} /> {LEVEL_LABEL[level]}</span>
        ))}
        <span><i className="ring" /> time till decay</span>
        <span><i className="ring slipping" /> slipping</span>
        <span><Warning size={12} weight="bold" color="var(--bad)" aria-hidden /> misconception</span>
      </div>
      )}
    </div>
  );
}
