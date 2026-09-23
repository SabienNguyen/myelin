import { test, expect } from '@playwright/test';

test.use({ baseURL: 'http://localhost:4174' });
for (const colorScheme of ['dark', 'light'] as const) {
  test(`workspace ${colorScheme}: graph, keyboard navigation and narrow layout`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/#/t/visual-${colorScheme}/page/stream-consumer`);
    await expect(page.locator('.page-panel h2')).toHaveText('Consuming SSE token streams');
    await page.getByRole('tab', {name:'graph', exact:true}).click();
    // sigma mounts SEVERAL layered canvases (edges/nodes/labels/hovers/mouse…) into .graph-canvas —
    // .first() picks one deterministically rather than a strict-mode violation on all of them.
    await expect(page.locator('.graph-canvas canvas').first()).toBeVisible();
    // Regression (caught by the first light-scheme run of the old SVG graph): zoom-to-fit once
    // magnified a still-hot simulation whose nodes were bunched near the origin, rendering
    // overlapping giant blobs — a settled node circle is small, a degenerate 6x fit made them
    // hundreds of px wide. The WebGL rewrite can't repeat that exact failure (GraphPanel.tsx's
    // doFit freezes the camera's bbox until the layout actually settles, so there is no "fit a
    // still-moving layout" step left to race), and individual node geometry is no longer a DOM
    // element this test can measure directly. The topic list is the surviving, queryable proxy for
    // "the graph tab rendered real, coherent content" rather than an empty or broken canvas.
    const topics = page.getByRole('region', { name: 'Topics in this view' });
    await expect(topics).toBeVisible();
    await expect(topics.getByRole('button', { name: /^Open Consuming SSE token streams/ })).toBeVisible();
    await page.screenshot({path:`test-results/workspace-${colorScheme}.png`, fullPage:true});
    const graph = page.getByRole('tab', {name:'graph',exact:true});
    await graph.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', {name:'page',exact:true})).toBeFocused();
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:`test-results/workspace-${colorScheme}-narrow.png`,fullPage:true});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
