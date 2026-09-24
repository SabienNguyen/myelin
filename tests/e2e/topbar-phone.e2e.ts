import { test, expect } from '@playwright/test';

// The phone topbar has no spare width: a filed conversation's notebook crumb once pushed Add material
// past the right edge at 390 px, where overflow-x: clip left no way to scroll to it.
test('Add material stays on screen in a filed conversation at phone widths', async ({ page }) => {
  const threadId = `t-phone-${Date.now().toString(36)}`;
  const created = await page.request.post('/api/notebooks', { data: { title: 'Introduction to Probability and Measure Theory' } });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  expect((await page.request.put(`/api/notebooks/${id}/threads/${threadId}`)).ok()).toBe(true);

  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/#/t/${threadId}/stage`);
    await expect(page.locator('.nb-crumb-trigger, .notebook-crumb-link').last()).toHaveAttribute('title', /Introduction to Probability/);
    const trigger = await page.locator('.add-material-trigger').boundingBox();
    expect(trigger!.x + trigger!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
