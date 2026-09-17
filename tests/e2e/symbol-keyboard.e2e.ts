import { test, expect } from '@playwright/test';

test.use({ baseURL: 'http://localhost:4174' });
test('symbol keyboard preserves selection, undo, and the chat request at desktop and narrow widths', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Exercise real composer/request serialization without making a paid model call.
  let sent: any;
  await page.route('**/api/chat', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ contentType: 'text/event-stream', body:
      'data: {"type":"start","messageId":"symbols-reply"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]\n\n' });
  });
  await page.goto('/#/t/symbols-e2e/stage');
  const composer = page.getByRole('textbox', { name: 'Ask your tutor…' });
  await expect(composer).toBeVisible();
  await composer.fill('L = rate W');
  // Native browser selection: avoid editor autofocus racing synthetic arrow-key setup.
  await composer.evaluate((el) => {
    (el as HTMLElement).focus();
    const text = el.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 4); range.setEnd(text, 8);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('rate');
  await page.locator('.composer-editor').getByRole('button', { name: 'Math symbols' }).click();
  await page.getByRole('button', { name: 'λ — lambda' }).click();
  await expect(composer).toHaveText('L = λ W');
  await composer.press('Control+z');
  await expect(composer).toHaveText('L = rate W');
  await page.getByRole('button', { name: 'λ — lambda' }).click();
  await expect(composer).toHaveText('L = λ W');
  await page.screenshot({ path: 'test-results/symbol-keyboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'λ — lambda' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/symbol-keyboard-mobile.png', fullPage: true });
  await composer.press('Enter');
  await expect.poll(() => sent?.messages?.at(-1)?.parts?.find((p: any) => p.type === 'text')?.text).toBe('L = λ W');
  expect(errors).toEqual([]);
});
