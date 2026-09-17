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
    await expect(page.locator('.graph-node').first()).toBeVisible();
    // Regression (caught by the first light-scheme run): zoom-to-fit once magnified a still-hot
    // simulation whose nodes were bunched near the origin, rendering overlapping giant blobs.
    // A settled node circle is small; a degenerate 6x fit made them hundreds of px wide.
    await expect(async () => {
      const box = await page.locator('.graph-node circle').first().boundingBox();
      expect(box!.width).toBeLessThan(60);
    }).toPass({ timeout: 15_000 });
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
