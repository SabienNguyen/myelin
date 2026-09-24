import { test, expect, type Page } from '@playwright/test';

// Must match src/client/graph/positionStore.ts's POSITIONS_KEY — duplicated here rather than
// imported because this spec runs under Playwright's own module loader, not Vite, and the two
// don't share a resolution graph worth coupling a perf test to.
const POSITIONS_KEY = 'myelin.graph.positions.v1';

const NODE_COUNT = 5_000;
const TARGET_EDGE_COUNT = 12_000;
const SETTLE_CEILING_MS = 20_000;

/**
 * Synthetic /api/graph payload in the real shape restRoutes.ts's fetchGraph() returns: one entry
 * per page (`slug`, `title`, `difficulty`, `status`, `prereqs`, `deepens`, `mastery`), where
 * `mastery` is either null or the whole-map get_student_state record graphLayout.ts's graphMeta()
 * reads (`effective`, `days_left`, `last_reinforced`, `slipped`, `misconceptions`). All nodes are
 * mastery: null here — this test is about layout/render throughput at scale, not the decay-ring
 * math, which graphModel.test.ts already covers directly.
 *
 * Edges are deterministic (no Math.random) so a failure is reproducible: a base ring (each node's
 * prereq is its predecessor) plus fixed-offset "deepens"/"prereq" chords added in waves until the
 * target edge count is hit. Duplicate pairs are possible (not de-duplicated here) but harmless —
 * graphMeta()/syncGraph() build a real edge per (src,dst,kind) regardless, so the produced graph is
 * always at least TARGET_EDGE_COUNT edges, which is what this test needs from a "12,000-edge
 * payload" claim, not an exact count.
 */
function buildSyntheticGraph(nodeCount: number, targetEdgeCount: number) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    slug: `node-${i}`,
    title: `Node ${i}`,
    difficulty: 1,
    status: 'active',
    prereqs: [] as string[],
    deepens: [] as string[],
    mastery: null as null,
  }));

  let edgeCount = 0;
  const addEdge = (i: number, offset: number, kind: 'prereqs' | 'deepens') => {
    if (edgeCount >= targetEdgeCount) return;
    const j = (i + offset) % nodeCount;
    if (j === i) return;
    nodes[i][kind].push(nodes[j].slug);
    edgeCount++;
  };

  let offset = 1;
  let kindToggle: 'prereqs' | 'deepens' = 'prereqs';
  while (edgeCount < targetEdgeCount) {
    for (let i = 0; i < nodeCount && edgeCount < targetEdgeCount; i++) {
      addEdge(i, offset, kindToggle);
    }
    offset += 3;
    kindToggle = kindToggle === 'prereqs' ? 'deepens' : 'prereqs';
  }

  return { nodes, goal: null, summary: {} };
}

async function startFrameCollection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __frameDeltas: number[]; __collectingFrames: boolean };
    w.__frameDeltas = [];
    w.__collectingFrames = true;
    let last = performance.now();
    const tick = () => {
      if (!w.__collectingFrames) return;
      const now = performance.now();
      w.__frameDeltas.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopFrameCollection(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __frameDeltas: number[]; __collectingFrames: boolean };
    w.__collectingFrames = false;
    return w.__frameDeltas;
  });
}

async function readPositionsCount(page: Page): Promise<{ count: number }> {
  return page.evaluate((key) => {
    try {
      const raw = localStorage.getItem(key);
      return { count: raw ? Object.keys(JSON.parse(raw)).length : 0 };
    } catch {
      return { count: 0 };
    }
  }, POSITIONS_KEY);
}

interface GraphProbe { order: number; finite: number; running: boolean }

/** GraphPanel's test hook (window.__myelinGraph, present under automation): nodes in the graph,
 *  nodes at a finite position inside the canvas, and whether the layout still runs. */
async function readProbe(page: Page): Promise<GraphProbe | null> {
  return page.evaluate(() => {
    const g = (window as unknown as { __myelinGraph?: GraphProbe }).__myelinGraph;
    return g ? { order: g.order, finite: g.finite, running: g.running } : null;
  });
}

/** Waits until the layout has every synthetic node, has stopped running, and has saved their
 *  positions (the settle handler saves), or `ceilingMs` elapses. */
async function waitForSettle(
  page: Page, expectedCount: number, ceilingMs: number,
): Promise<{ settled: boolean; elapsedMs: number }> {
  const start = Date.now();
  while (Date.now() - start < ceilingMs) {
    const probe = await readProbe(page);
    if (probe && probe.order === expectedCount && !probe.running) {
      const { count } = await readPositionsCount(page);
      if (count >= expectedCount) return { settled: true, elapsedMs: Date.now() - start };
    }
    await page.waitForTimeout(300);
  }
  return { settled: false, elapsedMs: ceilingMs };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

function logFrameStats(label: string, frames: number[]): { p50: number; p95: number; max: number } {
  const sorted = [...frames].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const max = sorted.length > 0 ? sorted[sorted.length - 1] : NaN;
  // eslint-disable-next-line no-console
  console.log(`[graph-perf] ${label}: n=${frames.length} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`);
  return { p50, p95, max };
}

/** Drags the canvas continuously for `ms` — a small back-and-forth sweep rather than one long
 *  throw, so the layout worker (still running post-settle for a moment, and definitely still
 *  running if settle never completed) keeps seeing fresh camera reads the whole window.
 *
 *  Starts near a CORNER, not the canvas centre: ForceAtlas2's gravity term pulls every node
 *  toward the layout's centre of mass, and the settle/Fit camera reset frames that centre of mass
 *  in the middle of the viewport — so a centre-start is close to the single likeliest point in the
 *  whole canvas to land ON a node. That silently swaps what this measures: mousedown on a node hits
 *  GraphPanel.tsx's onDownNode/pin() path instead of panning the empty background, and pin()
 *  restarts the FA2 worker if the layout had already settled (`if (!running) start()`) — this
 *  test would then be measuring "drag a node while the layout is restarting", a real but different
 *  and much heavier code path, not "pan the camera". A corner sits far from the gravity-drawn
 *  centre and reliably lands on empty background instead. */
async function panFor(page: Page, ms: number): Promise<void> {
  const canvas = page.locator('.graph-canvas canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('graph canvas has no bounding box to pan over');
  const cx = box.x + box.width * 0.12;
  const cy = box.y + box.height * 0.12;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const start = Date.now();
  let t = 0;
  while (Date.now() - start < ms) {
    t += 1;
    const dx = Math.sin(t / 3) * 120;
    const dy = Math.cos(t / 4) * 60;
    // eslint-disable-next-line no-await-in-loop
    await page.mouse.move(cx + dx, cy + dy, { steps: 2 });
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
}

test.describe('Graph performance — synthetic large vault', () => {
  test('lays out and pans a 5,000-node / 12,000-edge graph at an acceptable frame rate', async ({ page }) => {
    test.setTimeout(60_000);

    const payload = buildSyntheticGraph(NODE_COUNT, TARGET_EDGE_COUNT);
    const realEdgeCount = payload.nodes.reduce((n, node) => n + node.prereqs.length + node.deepens.length, 0);
    expect(realEdgeCount).toBeGreaterThanOrEqual(TARGET_EDGE_COUNT);

    await page.route('**/api/graph', (route) => route.fulfill({ json: payload }));
    const consoleLines: string[] = [];
    page.on('console', (msg) => consoleLines.push(msg.text()));
    // Cleared before the app's own scripts run (addInitScript fires ahead of page scripts on every
    // navigation) so a stale positions blob from an earlier spec in this shared browser context
    // can't make settle detection below pass instantly on data it never actually laid out.
    await page.addInitScript((key) => { try { localStorage.removeItem(key); } catch { /* ignored: same fallback positionStore.ts itself takes for a blocked localStorage */ } }, POSITIONS_KEY);

    await page.goto('/#/t/e2e-graph-perf/graph');

    // sigma mounts SEVERAL layered canvases (edges/nodes/labels/hovers/mouse…) into .graph-canvas —
    // .first() picks one deterministically rather than a strict-mode violation on all of them.
    await expect(page.locator('.graph-canvas canvas').first()).toBeVisible({ timeout: 15_000 });

    // Started only now, not before goto(): a navigation tears down the page's JS globals, so a
    // collector started pre-navigation would leave window.__frameDeltas undefined on the document
    // that actually renders the graph.
    await startFrameCollection(page);

    // Contextual mode with no page ever opened in this session has no seed to focus on, so
    // contextualSubgraph (GraphPanel.tsx) already falls back to the whole, unfiltered graph — the
    // ForceAtlas2 worker is therefore already running by the time this line executes. Switching to
    // "Whole vault" doesn't change node membership here (same slugs either way) and so does NOT
    // restart the layout; its fit waits for the running layout's settle.
    await page.getByRole('tab', { name: 'Whole vault' }).click();

    await page.waitForTimeout(3_000);
    const settlingFrames = await stopFrameCollection(page);
    logFrameStats('during settling (first ~3s from navigation)', settlingFrames);

    const { settled, elapsedMs: settleElapsedFromRestart } = await waitForSettle(page, NODE_COUNT, SETTLE_CEILING_MS);
    console.log(`[graph-perf] settle: ${settled ? 'reached' : 'DID NOT settle within ceiling'} after +${settleElapsedFromRestart}ms past the 3s settling sample (ceiling ${SETTLE_CEILING_MS}ms)`);
    expect(settled).toBe(true);
    // A settle forced by layout.ts's run cap is a layout that never converged, not a settled one.
    expect(consoleLines.filter((line) => line.includes('run cap'))).toEqual([]);
    // Every node drawn somewhere the learner can see once the settle's fit lands: NaN positions and
    // a stale frame both left nodes off the canvas while the old wall-clock check still passed.
    await expect.poll(async () => (await readProbe(page))?.finite, { timeout: 5_000 }).toBe(NODE_COUNT);

    await startFrameCollection(page);
    await panFor(page, 2_000);
    const panFrames = await stopFrameCollection(page);
    const panStats = logFrameStats('panning (2s scripted drag)', panFrames);

    expect(panFrames.length).toBeGreaterThan(0);
    expect(panStats.p50).toBeLessThanOrEqual(20);
  });
});
