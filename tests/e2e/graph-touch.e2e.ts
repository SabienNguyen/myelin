import { test, expect } from '@playwright/test';

// The sparse-graph pair (:4174) serves the fixture page this taps through to.
test.use({ baseURL: 'http://localhost:4174', hasTouch: true });

// A tap on a node never opened its page: the press and release handlers listened to the mouse
// only, and the page opened on mouseup, which a touch never sends.
test('tapping a graph node on a touch screen opens its page', async ({ page }) => {
  await page.route('**/api/graph', (route) => route.fulfill({ json: { nodes: [
    { slug: 'stream-consumer', title: 'Consuming SSE token streams', prereqs: [], deepens: [], mastery: null },
  ] } }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/t/graph-touch/graph');
  // A tab-only hash keeps a freshly-collapsed panel collapsed — expand it onto the graph.
  await page.getByRole('button', { name: 'Expand side panel' }).click();
  const canvas = page.locator('.graph-canvas');
  await expect(canvas.locator('canvas').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const g = (window as unknown as { __myelinGraph?: { finite: number; running: boolean } }).__myelinGraph;
    return g != null && !g.running && g.finite === 1;
  })).toBe(true);

  // One node, fitted: it sits at the centre of the canvas.
  const box = (await canvas.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.page-panel h2')).toHaveText('Consuming SSE token streams');
});
