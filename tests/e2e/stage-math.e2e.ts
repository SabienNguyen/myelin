import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test.use({ baseURL: 'http://localhost:4174' });
test('completed math remains readable in Stage after reload in both themes', async ({ page }) => {
  const sessions = join(dirname(fileURLToPath(import.meta.url)), '.tmp-vault-gap', '.harness', 'sessions');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'math-review.json'), JSON.stringify([
    { id: 'u', role: 'user', parts: [{ type: 'text', text: 'Help me differentiate x squared.' }] },
    { id: 'a', role: 'assistant', parts: [{ type: 'tool-math_scratchpad', toolCallId: 'math',
      state: 'output-available', input: { problemLatex: 'x^2', expectedLatex: '2x', pageSlug: 'derivatives', stepMode: true },
      output: { steps: [{ latex: 'x+x' }, { latex: '2x' }], finalLatex: '2x',
        grading: { verdict: 'correct', detail: 'Derivative is correct.', evidence: [] } } }] },
  ]));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto('/#/t/math-review/stage');
    // A prior graded exercise doesn't itself expand a freshly-collapsed panel — only a deliberate
    // navigation does (StagePortal's setTab fires for a LIVE stage, not replayed history). The
    // second loop iteration reloads with the FIRST iteration's now-stored "expanded" preference,
    // so the rail's expand button may already be gone.
    await page.getByRole('button', { name: /^(Expand|Collapse) side panel$/ }).waitFor();
    const expandToggle = page.getByRole('button', { name: 'Expand side panel' });
    if (await expandToggle.count()) await expandToggle.click();
    const summary = page.getByRole('region', { name: 'Latest exercise' });
    await expect(summary.getByText('Your work', { exact: true })).toBeVisible();
    await expect(page.getByText(/could not be shown/i)).toHaveCount(0);
    await expect(page.getByLabel('Conversation transcript').locator('.math-scratchpad, .block.done')).toBeVisible();
    await expect(summary.locator('.katex')).toHaveCount(4);
    await expect(summary.getByRole('status')).toHaveText('Derivative is correct.');
    await expect(page.getByRole('heading', { name: 'stage' })).toBeHidden();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await summary.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/stage-math-${colorScheme}-${width}.png`, fullPage: true });
    }
  }
  expect(errors).toEqual([]);
});
