import { test, expect } from '@playwright/test';

// This file's dedicated backend+frontend pair (playwright.config.ts) serves on :4174/:4821 — same
// pair gap-exercise.e2e.ts uses, and for the same reason: arbitrary navigation here never lands
// on tutor-loop.e2e.ts's :4830/:4183 pair, whose scripted model counts turns for the life of its
// process (see playwright.config.ts's own comment on the webServer pairs).
test.use({ baseURL: 'http://localhost:4174' });

// The hub and its 1-hop/2-hop fixture pages are written by global-setup.ts (see GAP_FIXTURE_PAGES
// there) — BEFORE any test runs, deliberately: the backend's /api/graph payload is TTL-cached
// (src/server/graphCache.ts), and when the gap tests run first, their chat turns warm that cache.
// Fixture pages written in a beforeAll here landed AFTER the warm, so this test read a
// fresh-by-TTL cache built from a vault that didn't yet contain its own fixtures. The hub is its
// own page rather than the boot-seeded stream-consumer, which /api/graph hides until it has
// evidence — this test used to pass only after gap-exercise.e2e.ts had graded it.

test.describe('Graph tab — contextual scope', () => {

  test('defaults to a contextual subgraph around the open page, with a subtitle and a scope toggle', async ({ page }) => {
    // Deep-link straight into the Page tab already showing 'stream-basics' — GraphPanel seeds
    // its context from the URL hash at mount (see GraphPanel.tsx's contextSeed useState
    // initializer), so switching to Graph afterward should show it already scoped, with no chat
    // turn or click needed to establish the "open page" signal.
    await page.goto('/#/t/e2e-graph-ctx/page/stream-basics');
    await expect(page.locator('.page-panel h2')).toHaveText('Stream Basics');

    await page.getByRole('tab', { name: 'graph' }).click();

    await expect(page.getByRole('tab', { name: 'This topic' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Whole vault' })).toBeVisible();
    await expect(page.locator('.graph-subtitle')).toHaveText(/around Stream Basics · 2 hops/i);

    // The canvas is a WebGL surface (sigma mounts its own <canvas> into .graph-canvas) — its
    // presence, rather than any SVG node markup, is now the sign that rendering actually worked
    // instead of silently falling back to the "needs WebGL" message.
    // sigma mounts SEVERAL layered canvases (edges/nodes/labels/hovers/mouse…) into .graph-canvas —
    // .first() picks one deterministically rather than a strict-mode violation on all of them.
    await expect(page.locator('.graph-canvas canvas').first()).toBeVisible();

    // 1-hop and 2-hop neighbors render as topic-list buttons, scoped to the graph panel. Their
    // accessible name is now `Open <title>, <standing>[, <decay/slip/misconception facts>]`, so a
    // plain-string getByRole match (substring by default) still finds them without needing the
    // exact suffix.
    const graph = page.locator('#panel-graph');
    const topics = graph.getByRole('region', { name: 'Topics in this view' });
    await expect(topics.getByRole('button', { name: /^Open Stream Decoding/ })).toBeVisible();
    await expect(topics.getByRole('button', { name: /^Open Backpressure Handling/ })).toBeVisible();
    await expect(topics.getByRole('button', { name: /^Open Reconnect Strategy/ })).toBeVisible();
    // ...but the deliberately-disconnected page does not — proof the view is actually scoped, not
    // just the full graph relabeled.
    await expect(topics.getByRole('button', { name: /^Open Totally Unrelated Topic/ })).toHaveCount(0);

    await page.screenshot({ path: 'test-results/graph-contextual.png', fullPage: true });

    // Clicking a topic opens the real page panel — the topic list is the actual interaction
    // surface now that the canvas is aria-hidden.
    await topics.getByRole('button', { name: /^Open Stream Decoding/ }).click();
    await expect(page.locator('.page-panel h2')).toHaveText('Stream Decoding');

    // Back to the graph tab, then the whole-vault escape hatch: toggling reveals the
    // previously-hidden disconnected page and drops the subtitle.
    await page.getByRole('tab', { name: 'graph' }).click();
    await page.getByRole('tab', { name: 'Whole vault' }).click();
    await expect(topics.getByRole('button', { name: /^Open Totally Unrelated Topic/ })).toBeVisible();
    await expect(page.locator('.graph-subtitle')).toHaveCount(0);
  });
});
