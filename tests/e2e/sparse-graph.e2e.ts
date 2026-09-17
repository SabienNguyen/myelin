import { test, expect } from '@playwright/test';

test.use({ baseURL: 'http://localhost:4174' });
test('sparse graph has readable status and opens the real page', async ({ page }) => {
  // Deliberately sparse graph fixture; page navigation still uses the fixture server.
  await page.route('**/api/graph', route => route.fulfill({ json: { nodes: [
    { slug: 'stream-consumer', title: 'Consuming SSE token streams', prereqs: [], deepens: [], mastery: null },
  ] } }));
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto('/#/t/sparse-map/graph');
    const topics = page.getByRole('region', { name: 'Topics in this view' });
    await expect(topics).toBeVisible();
    await expect(topics.getByText('unseen', { exact: true })).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await topics.scrollIntoViewIfNeeded();
      const button = topics.getByRole('button', { name: 'Open Consuming SSE token streams' });
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await page.locator('.graph-canvas').boundingBox())!.height).toBeLessThanOrEqual(280);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/sparse-${colorScheme}-${width}.png`, fullPage: true });
    }
    await topics.getByRole('button', { name: 'Open Consuming SSE token streams' }).click();
    await expect(page.locator('.page-panel h2')).toHaveText('Consuming SSE token streams');
  }
});
