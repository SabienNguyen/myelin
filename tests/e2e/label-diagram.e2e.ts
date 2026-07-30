import { test, expect } from '@playwright/test';

/**
 * label_diagram in a real browser, deliberately shaped like the live sitting that found three
 * bugs in one exercise (verdict addendum, 2026-07-27):
 *  - the SVG arrives HTML-entity-escaped (`&lt;svg…`) — must decode and render, not collapse the
 *    canvas into an unclickable band;
 *  - two regions share IDENTICAL coordinates — separatePins must keep both clickable;
 *  - one label is needed TWICE — its tray chip must survive the first placement.
 * Own backend pair (:4822/:4175) for the same scripted-turn-counter reason as the gap spec.
 */
test('an escaped-SVG diagram with coincident pins and a duplicate label completes to a grade', async ({ page }) => {
  const first = page.waitForResponse((r) => r.url().endsWith('/api/chat'));
  await page.goto('http://localhost:4175/');
  await page.getByRole('textbox', { name: 'Ask your tutor…' }).fill('teach me the water cycle');
  await page.keyboard.press('Enter');
  await first;

  await page.getByRole('button', { name: 'Diagram waiting on the stage' }).waitFor();

  // The decoded SVG (viewBox 100x60) plus the canvas min-height guarantee real clickable space —
  // the escaped original rendered ~26px tall and buried every pin.
  const canvas = await page.locator('.label-diagram-canvas').boundingBox();
  expect(canvas!.height).toBeGreaterThan(150);

  // Both coincident pins are individually clickable (separatePins nudged them apart).
  const place = async (region: string, label: string) => {
    await page.locator('.label-chip', { hasText: label }).first().click();
    await page.locator(`.label-pin[aria-label*="region ${region}"]`).click();
  };
  await place('up', 'Evaporation');
  await place('cloud', 'Condensation');
  // The duplicate-label chip must still be enabled for its second region.
  const dup = page.locator('.label-chip', { hasText: 'Condensation' }).first();
  await expect(dup).toBeEnabled();
  await place('down', 'Condensation');

  const followUp = page.waitForResponse((r) => r.url().endsWith('/api/chat'));
  await page.getByRole('button', { name: 'Submit' }).click();
  await followUp;

  // Graded done card: all three correct, and the scripted tutor's follow-up turn rendered.
  await expect(page.locator('.block.done .graded-tag')).toBeVisible();
  await expect(page.getByText('3/3 regions labelled correctly')).toBeVisible();
  await expect(page.getByText('All three placed — the cycle is yours.', { exact: true })).toBeVisible();
});
