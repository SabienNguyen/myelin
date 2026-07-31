import { test, expect } from '@playwright/test';

// This file's dedicated backend+frontend pair (playwright.config.ts) serves on :4174/:4821 — same
// pair gap-exercise.e2e.ts uses, and for the same reason: arbitrary navigation here never lands
// on tutor-loop.e2e.ts's :4830/:4183 pair, whose scripted model counts turns for the life of its
// process (see playwright.config.ts's own comment on the webServer pairs).
test.use({ baseURL: 'http://localhost:4174' });

// The 1-hop/2-hop fixture pages this file asserts against are written by global-setup.ts (see
// GAP_FIXTURE_PAGES there) — BEFORE any test runs, deliberately: the backend's /api/graph payload
// is TTL-cached (src/server/graphCache.ts), and when the gap tests run first, their chat turns
// warm that cache. Fixture pages written in a beforeAll here landed AFTER the warm, so this test
// read a fresh-by-TTL cache built from a vault that didn't yet contain its own fixtures.

test.describe('Graph tab — contextual scope', () => {

  test('defaults to a contextual subgraph around the open page, with a subtitle and a scope toggle', async ({ page }) => {
    // Deep-link straight into the Page tab already showing 'stream-consumer' — GraphPanel seeds
    // its context from the URL hash at mount (see GraphPanel.tsx's contextSeed useState
    // initializer), so switching to Graph afterward should show it already scoped, with no chat
    // turn or click needed to establish the "open page" signal.
    await page.goto('/#/t/e2e-graph-ctx/page/stream-consumer');
    // Scoped to PagePanel's own <h2> title: stream-consumer.md's body ALSO opens with a markdown
    // `# Consuming SSE token streams` heading, which renders as an <h1> with the same text — an
    // unscoped role query would resolve ambiguously between the two.
    await expect(page.locator('.page-panel h2')).toHaveText('Consuming SSE token streams');

    await page.getByRole('tab', { name: 'graph' }).click();

    await expect(page.getByRole('tab', { name: 'This topic' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Whole vault' })).toBeVisible();
    await expect(page.locator('.graph-subtitle')).toHaveText(/around Consuming SSE token streams · 2 hops/i);

    // 1-hop and 2-hop neighbors render, scoped to the graph panel: exact: true disambiguates from
    // each node's SVG <title> tooltip ("Stream Decoding — unseen"), and the panel scope
    // disambiguates from the Page tab's page-edge-link buttons (a later feature), which render the
    // SAME titles as prereq links in the hidden page panel and trip strict mode.
    const graph = page.locator('#panel-graph');
    await expect(graph.getByText('Stream Decoding', { exact: true })).toBeVisible();
    await expect(graph.getByText('Backpressure Handling', { exact: true })).toBeVisible();
    await expect(graph.getByText('Reconnect Strategy', { exact: true })).toBeVisible();
    // ...but the deliberately-disconnected page does not — proof the view is actually scoped, not
    // just the full graph relabeled.
    await expect(graph.getByText('Totally Unrelated Topic', { exact: true })).toHaveCount(0);

    await page.screenshot({ path: 'test-results/graph-contextual.png', fullPage: true });

    // Whole vault escape hatch: toggling reveals the previously-hidden disconnected page and
    // drops the subtitle.
    await page.getByRole('tab', { name: 'Whole vault' }).click();
    await expect(page.getByText('Totally Unrelated Topic', { exact: true })).toBeVisible();
    await expect(page.locator('.graph-subtitle')).toHaveCount(0);
  });
});
