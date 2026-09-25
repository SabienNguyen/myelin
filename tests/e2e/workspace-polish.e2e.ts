import { test, expect } from '@playwright/test';

test.use({ baseURL: 'http://localhost:4174' });
for (const colorScheme of ['light', 'dark'] as const) {
  test(`workspace hierarchy and composer geometry (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto(`/#/t/polish-${colorScheme}/stage`);
    // No stored preference: the panel starts collapsed as an icon rail.
    await page.getByRole('button', { name: 'Expand side panel' }).click();
    await expect(page.getByRole('heading', { name: 'stage' })).toBeVisible();
    await expect(page.getByText('Quizzes and exercises the tutor sets land here.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your workspace' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Browse library' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Explore knowledge graph' })).toHaveCount(0);
    await page.getByRole('tab', { name: /^library/ }).click();
    await expect(page.getByRole('tab', { name: /^library/ })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'stage', exact: true }).click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const toggle = page.locator('.composer').getByRole('button', { name: 'Math symbols' });
      await toggle.click();
      const card = await page.locator('.composer-row').boundingBox();
      const popup = await page.locator('.composer .symbol-panel').boundingBox();
      const send = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox();
      expect(card!.height).toBeLessThan(180);
      expect(card!.width).toBeLessThanOrEqual(760);
      expect(send!.y).toBeGreaterThan(card!.y);
      expect(send!.y + send!.height).toBeLessThanOrEqual(card!.y + card!.height);
      expect(popup!.y).toBeGreaterThanOrEqual(0);
      expect(popup!.y + popup!.height).toBeLessThanOrEqual(card!.y);
      expect(popup!.x + popup!.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/polish-${colorScheme}-${width}.png`, fullPage: true });
      await toggle.click();
    }
  });
}
