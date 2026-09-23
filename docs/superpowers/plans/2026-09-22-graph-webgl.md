# Graph view → WebGL (sigma.js + graphology + ForceAtlas2 worker) — implementation plan

Repo: /home/sabien/Dev/personal/myelin. Client is React 19 + Vite + plain CSS. Read
`.claude/skills/no-slop-code/SKILL.md` and `.claude/skills/no-slop-ui/SKILL.md` before writing code;
they are binding (tokens not hex in CSS, no emoji in UI, degrade loudly, tests assert behaviour,
comments explain failure modes not lines). The user has UNCOMMITTED work in this tree — never run
git stash/checkout/reset/commit, and touch only the files your task names.

## Why (the approved design, condensed)

Target: thousands of pages. The current SVG GraphPanel re-renders every node through React on every
d3-force tick and re-fits the camera every 100ms while settling. User complaints: sluggish, "stiff"
(snaps and stops dead; label-sized collide boxes), "dragging is weird" (hard reheat, camera refits
under the cursor), "settling on load is weird" (every node bursts from the origin while the camera
keeps re-zooming).

Design:
- Render with sigma@3 (WebGL) over a graphology graph. Layout with graphology-layout-forceatlas2's
  Web Worker supervisor; Barnes-Hut when > 500 nodes; no collide force.
- Positions persist per slug in localStorage; new nodes spawn beside an already-placed neighbour;
  a brand-new vault seeds a random disc.
- Camera: sigma's per-frame auto-rescale is frozen (custom bbox) so the layout settles INSIDE a fixed
  frame; one animated fit on settle; afterwards the camera moves only on user pan/zoom or Fit.
- Drag: grabbed node pinned under the cursor (`fixed` attr) while the worker keeps running so
  neighbours follow; on release unpin, run ≈1.5s more, stop. Dragging never moves the camera.
- Hover (or keyboard focus in the topic list): node + neighbours + their edges stay; the rest mute.
- Labels: sigma's label grid; in contextual mode (≤ 40 nodes) every label is forced on.
- Accessibility: canvas is aria-hidden; the DOM topic list is the keyboard/screen-reader surface.
- Degrade loudly: no WebGL → message + topic list + console.error; worker failure → console.error +
  synchronous ForceAtlas2 iterations.
- prefers-reduced-motion: synchronous layout, no animated fit.
- Unchanged: /api/graph, 30s polling, panelBus, contextualSubgraph, mastery colours.

## Review notes from completed tasks (binding for later tasks)

- T1 (done): graphology's default export does not typecheck under this repo's NodeNext resolution.
  Construct graphs with `import { MultiDirectedGraph } from 'graphology'` → `new MultiDirectedGraph<NodeAttrs, EdgeAttrs>()`
  (buildGraph.ts aliases it as `Graph`; `MasteryGraph` is the type to use). Never `import Graph from 'graphology'`.
  If `graphology-layout-forceatlas2` or `sigma` default imports hit the same problem, prefer their named
  exports / subpath exports and document the workaround at the import, as buildGraph.ts does.
- T3 (done): sigma's bundle reads `WebGLRenderingContext`/`WebGL2RenderingContext` constants AT MODULE
  LOAD, so a static `import Sigma from 'sigma'` (or of nodeProgram.ts) makes GraphPanel.tsx itself
  throw on import in jsdom and in any browser without WebGL. T4 MUST load both lazily inside the
  mount effect — `const [{ default: Sigma }, { MasteryNodeProgram }] = await Promise.all([import('sigma'),
  import('../graph/nodeProgram.js')])` (use whatever export shape actually typechecks) — and route an
  import OR constructor failure into the same "graph view needs WebGL" fallback + console.error.
  Only `import type` from sigma at the top of GraphPanel.tsx. Set `MasteryNodeProgram.warnColor =
  colors.warn` before constructing Sigma.

## Dependency order

T1 → (T2 ∥ T3) → T4 → T5

---

## T1 — dependencies, graph model, highlight rules

Install (exact): `npm install sigma@3.0.3 graphology@0.26.0 graphology-layout-forceatlas2@0.10.1`
and `npm install -D graphology-types@0.24.8`. (Needs network; run with sandbox disabled if blocked.)

Create `src/client/graph/buildGraph.ts`:

```ts
import Graph from 'graphology';
import type { GraphNodeMeta } from '../lib/graphLayout.js';
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
}

export const NODE_SIZE_SCALE = 0.5;   // radiusForDegree(px) → sigma size
export const SEED_JITTER = 20;

/** Resolved from CSS tokens (--text-muted, --border, --text, --warn, --bad, --bg-panel) with
 *  hex fallbacks for jsdom, same pattern as graphLayout.ts's masteryColors. Edge colours carry
 *  alpha via rgba(): prereq = --text-muted @0.75, deepens = --text-muted @0.4, muted = --border @0.35. */
export function resolveGraphColors(): GraphColors;

/** '#rrggbb' → 'rgba(r, g, b, a)'. Throws on anything else (tokens are hex; a new format must be
 *  noticed, not silently drawn black). */
export function withAlpha(hex: string, alpha: number): string;

/** Where a node with no remembered position starts: the mean of its already-placed neighbours plus
 *  jitter in [-SEED_JITTER, SEED_JITTER]; with none placed, a uniform point in a disc of radius
 *  30 * sqrt(totalNodes). `rand` is injectable for tests (defaults Math.random). */
export function seedPosition(placedNeighbours: Point[], totalNodes: number, rand?: () => number): Point;

/** Makes `graph` match `sub` IN PLACE so the live layout keeps running: removes nodes not in `sub`,
 *  adds new ones (position from `remembered`, else seedPosition from neighbours placed so far in
 *  this pass or already in the graph), updates every surviving node's display attrs WITHOUT
 *  touching its x/y, and replaces the edge set. Returns the slugs added and removed. */
export function syncGraph(
  graph: MasteryGraph, sub: Subgraph<GraphNodeMeta>, remembered: ReadonlyMap<string, Point>,
  opts: { forceLabels: boolean; colors: GraphColors; rand?: () => number },
): { added: string[]; removed: string[] };
```
Node attrs: size = radiusForDegree(degree) * NODE_SIZE_SCALE, color = meta.color, label = title.
Edge key `${kind}:${src}->${dst}`, size 1 (prereq) / 0.8 (deepens). Use `graph.mergeEdgeWithKey` or
clear+add; duplicates across kinds must not throw (graph must be `multi: false` but keyed per kind —
construct with `new Graph({ type: 'directed', multi: true })` in callers/tests).

Create `src/client/graph/highlight.ts`:

```ts
import type { MasteryGraph } from './buildGraph.js';
/** focus + its direct neighbours (either direction), or null when nothing is focused. */
export function focusNeighbourhood(graph: MasteryGraph, focus: string | null): Set<string> | null;
/** sigma nodeReducer: null set → data unchanged. In set → { ...data, zIndex: 1, forceLabel: true,
 *  highlighted: node === focus }. Outside → { ...data, color: mutedColor, label: '', zIndex: 0 }. */
export function nodeReducer(focus: string | null, set: ReadonlySet<string> | null, mutedColor: string):
  (node: string, data: Record<string, unknown>) => Record<string, unknown>;
/** sigma edgeReducer: null set → unchanged. Both endpoints in set → { ...data, zIndex: 1,
 *  size: (data.size as number) * 1.6 }. Otherwise → { ...data, color: mutedColor, zIndex: 0 }. */
export function edgeReducer(graph: MasteryGraph, set: ReadonlySet<string> | null, mutedColor: string):
  (edge: string, data: Record<string, unknown>) => Record<string, unknown>;
```

Tests: `tests/client/graphModel.test.ts` — withAlpha (valid + throws), seedPosition (mean+jitter
bounds with a fixed rand; disc bound with none placed), syncGraph (adds/removes, keeps x/y of
survivors across a second sync, uses remembered positions, seeds a new node near its placed
neighbour, forceLabel propagates, edges replaced), focusNeighbourhood, both reducers.
Touch only: package.json, package-lock.json, src/client/graph/buildGraph.ts,
src/client/graph/highlight.ts, tests/client/graphModel.test.ts.

## T2 — layout controller + position memory

Create `src/client/graph/layout.ts`:

```ts
import type { MasteryGraph } from './buildGraph.js';
export const LAYOUT = {
  barnesHutAbove: 500, slowDown: 6, gravity: 0.6, scalingRatio: 8,
  settleCheckMs: 250, settleEpsilon: 0.15, settleChecks: 2,
  releaseRunMs: 1500, syncIterations: 150,
} as const;
export interface LayoutController {
  start(): void;                 // (re)start the worker; no-op if running
  stop(): void;
  kill(): void;                  // terminate worker, clear timers — call on unmount
  isRunning(): boolean;
  pin(node: string, x: number, y: number): void;   // set x/y + fixed=true; ensure running
  release(node: string): void;   // fixed=false; run ≤ releaseRunMs, then stop (unless settled first)
  onSettle(cb: () => void): () => void;            // returns unsubscribe
}
/** Mean per-node displacement between `prev` (x0,y0,x1,y1… in graph.forEachNode order) and the
 *  graph now. Pure; used by settle detection. */
export function meanDisplacement(prev: Float64Array, graph: MasteryGraph): number;
export function snapshot(graph: MasteryGraph): Float64Array;
export function createLayout(graph: MasteryGraph, opts?: { reducedMotion?: boolean }): LayoutController;
```
- Uses `FA2Layout` from 'graphology-layout-forceatlas2/worker' with settings
  `{ ...forceAtlas2.inferSettings(graph), barnesHutOptimize: order > LAYOUT.barnesHutAbove,
  slowDown, gravity, scalingRatio, adjustSizes: false }`.
- Settle: every settleCheckMs while running, compare snapshot; `settleChecks` consecutive readings
  below settleEpsilon → stop() and fire onSettle callbacks. Snapshot resets when node count changes.
- reducedMotion: start() runs `forceAtlas2.assign(graph, { iterations: syncIterations, settings })`
  synchronously and fires settle; never creates a worker.
- Worker construction throwing → `console.error('[graph] layout worker failed, laying out on the
  main thread:', err)` and behave as reducedMotion.

Create `src/client/graph/positionStore.ts`:

```ts
import type { MasteryGraph, Point } from './buildGraph.js';
export const POSITIONS_KEY = 'myelin.graph.positions.v1';
export const MAX_REMEMBERED = 20_000;
export function loadPositions(storage?: Storage | null): Map<string, Point>;
export function savePositions(graph: MasteryGraph, storage?: Storage | null): void;
```
Default storage = `globalThis.localStorage`, wrapped in try/catch (it can throw or be absent). Load:
bad JSON / wrong shape → console.warn and empty map. Save merges over what is stored (the other
scope's nodes survive), drops non-finite coords, keeps at most MAX_REMEMBERED (newest write wins).
Save failure (quota) → console.warn, never throws.

Tests: `tests/client/graphLayout2.test.ts` — meanDisplacement/snapshot; createLayout with
reducedMotion true fires onSettle and moves nodes, never touching Worker (assert `globalThis.Worker`
undefined in jsdom is fine); worker-failure path (stub `globalThis.Worker` to a class whose ctor
throws → console.error called with '[graph]' prefix and layout still settles); positionStore
round-trip, merge, cap, bad JSON, throwing storage.
Touch only: src/client/graph/layout.ts, src/client/graph/positionStore.ts,
tests/client/graphLayout2.test.ts.

## T3 — mastery node program (WebGL)

Create `src/client/graph/nodeProgram.ts` exporting `class MasteryNodeProgram` — a sigma v3 node
program, modelled on sigma's own circle program (read `node_modules/sigma/rendering/programs/
node-circle/` and `node_modules/sigma/rendering/node.ts` or their dist equivalents first — copy its
structure, uniforms and `processVisibleItem` pattern exactly). It draws, per node:
- a filled disc of `color` at radius `size`;
- if `ringFraction` is a number: an arc ring just outside the disc (gap ≈ 18% of radius, stroke
  ≈ 14% of radius, min 1.5px on screen), same colour, from 12 o'clock clockwise for
  `ringFraction * 2π`;
- if `slipped`: a full dashed ring at the same radius in the `warn` colour (≈ 12 dashes);
- anti-aliased edges (smoothstep over ~1px, as sigma's circle program does).
`ringFraction` null → pass -1 as the attribute; `slipped` → 0/1. The warn colour is a uniform set
via a static `MasteryNodeProgram.warnColor` (string, parsed with sigma's `floatColor`) that T4 sets
from resolveGraphColors().warn before constructing Sigma. The quad must be large enough to contain
the ring (scale the vertex quad by ~1.45 when a ring is present, or always).
No unit test is possible without WebGL; instead add `tests/client/nodeProgram.test.ts` that only
asserts the class exists, extends sigma's NodeProgram, and its `getDefinition()` declares the
`a_ringFraction` and `a_slipped` attributes (catches a broken import/definition at test time).
Touch only: src/client/graph/nodeProgram.ts, tests/client/nodeProgram.test.ts.

## T4 — GraphPanel rewrite

Rewrite `src/client/components/GraphPanel.tsx` on T1–T3. KEEP these exports byte-compatible (tests
import them): `POLL_MS`, `CONTEXT_HOPS`, `CONTEXT_CAP`, `ContextualNode`, `Subgraph`,
`contextualSubgraph`, `neighborSlugs`, `GraphPanel({ visible })`. Keep, unchanged in behaviour:
polling + error/empty/loading states and their copy, panelBus + hash re-seeding, the
"This topic / Whole vault" tablist (role=tab, aria-selected, useTablistKeys), the Fit button,
subtitle copy, legend, the topic list section (`aria-label="Topics in this view"`, one button per
node, `Open ${title}` names, standing text). Remove d3-force/d3-drag/d3-selection/d3-zoom usage and
uninstall those four packages (`npm uninstall …`) — nothing else imports them.

New behaviour:
- One `Sigma` instance per mount on a `<div className="graph-canvas" aria-hidden="true">`, graph
  `new Graph({ type: 'directed', multi: true })`, settings: `nodeProgramClasses: { mastery:
  MasteryNodeProgram }`, `defaultNodeType: 'mastery'`, `renderEdgeLabels: false`, `zIndex: true`,
  `labelColor: { color: colors.label }`, `labelFont` = computed `--font-prose` family,
  `labelRenderedSizeThreshold: 6`, `labelDensity: 0.6`, `allowInvalidContainer: true`,
  node/edge reducers from highlight.ts driven by `focus` (hovered node from sigma enterNode/leaveNode
  OR the topic-list button with keyboard focus/hover).
- Sigma constructor throwing (no WebGL — the jsdom case too) → `console.error('[graph] WebGL
  unavailable:', err)`, render `<p className="graph-subtitle graph-error" role="status">graph view
  needs WebGL — showing the topic list instead</p>` and the topic list; no canvas.
- On each `sub` change: `syncGraph(graph, sub, loadPositions(), { forceLabels: sub.nodes.length <=
  CONTEXT_CAP, colors })`; if membership changed → `layout.start()` and (unless the user has
  panned/zoomed since the last membership change) mark a fit pending.
- Camera: freeze sigma's auto-rescale — call `renderer.setCustomBBox(renderer.getBBox())` right after
  the first sync so the frame does not chase the layout; on layout settle → `savePositions(graph)`,
  and if a fit is pending → reset the custom bbox to the new graph bbox and `camera.animatedReset({
  duration: 300 })` (no animation when reduced motion). Fit button → same, forced. Any user
  wheel/drag of the stage clears the pending fit (`userAdjusted`).
- Drag: `downNode` → start dragging; on `mousemovebody` convert with `renderer.viewportToGraph(e)`,
  `layout.pin(node, x, y)`, `e.preventSigmaDefault()`, `e.original.preventDefault()`,
  `e.original.stopPropagation()`; `mouseup` → `layout.release(node)`. Movement < 4px between down
  and up counts as a click (select + `panelBus.openPage(slug)`), matching the old SVG behaviour.
- Selected node: the "Teach me this" `<button type="button">` is an absolutely-positioned HTML
  overlay placed with `renderer.graphToViewport(node)` and updated on the renderer's
  `afterRender` event; it calls `threadRuntime.append(\`Teach me ${slug} now\`)` exactly as today.
- Misconception markers: absolutely-positioned overlay per node with misconceptions, Phosphor
  `Warning` icon (`@phosphor-icons/react`, weight "bold", colour `var(--bad)`), `title` = the
  misconceptions joined by '; ', positioned at the node's top-right via graphToViewport on
  afterRender; hidden when the node is outside the viewport. `aria-hidden` (the list carries it).
- Topic list items gain the fact text the old SVG aria-label had (standing, days until decay,
  "slipping — due for review", "has a recorded misconception") in their accessible name, and
  ArrowUp/ArrowDown move focus between them (reuse `useRovingKeys` from ../lib/tablist.js as the old
  node group did). Focus/hover on an item sets `focus` so the canvas highlights it.
- prefers-reduced-motion (matchMedia) → `createLayout(graph, { reducedMotion: true })`, no animated
  fit.
- Unmount: `layout.kill()`, `savePositions(graph)`, `renderer.kill()`.
- CSS: replace the SVG-specific rules (.graph-svg, .graph-edge*, .graph-node*, focus/slip ring
  classes) in src/client/styles.css with what the new DOM needs (.graph-canvas sizing stays; add
  .graph-overlay, .graph-teach, .graph-misconception). Tokens only.

Update `tests/client/graphPanel.test.tsx`: keep every contextualSubgraph/neighborSlugs test as is.
Component tests run in jsdom where WebGL is absent, so they exercise the fallback: assert the
WebGL message renders with role=status, the topic list carries the scoped nodes (the 151-node test
becomes: topic list has only the contextual nodes), clicking a topic opens via panelBus, the scope
tabs still switch, the loading placeholder rules still hold. Replace SVG-node queries with topic-list
queries. Do not mock sigma.
Touch only: src/client/components/GraphPanel.tsx, src/client/styles.css (graph rules only),
tests/client/graphPanel.test.tsx, package.json, package-lock.json.

## T5 — e2e + performance evidence

Update `tests/e2e/graph-contextual.e2e.ts` and `tests/e2e/sparse-graph.e2e.ts` to the new DOM (the
topic list and `.graph-canvas canvas`); they run in real Chromium, so assert the canvas exists and
that clicking a topic opens the page. Add `tests/e2e/graph-perf.e2e.ts` that builds a synthetic
5,000-node / 12,000-edge `/api/graph` payload via `page.route('**/api/graph', …)`, opens Whole vault,
waits for settle, then measures frame times over 2s of scripted panning (requestAnimationFrame
deltas via page.evaluate) and asserts median ≤ 20ms; log p50/p95 to stdout. Follow
`.claude/skills/browser-verify/SKILL.md` for how the e2e stack boots.
Touch only those three e2e files.
