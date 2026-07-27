import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The video happy path, in a real browser: paste a YouTube URL into the single Add material
 * control -> the backend resolves captions through yt-dlp (the fake-bin shim on the webServer's
 * PATH — same observable surface as the real binary, no network) -> a timestamped transcript
 * with deep-link stamps lands in the vault and the Library takes over. Until this spec, the
 * happy path lived only at route level with injected fakes; the browser had only ever driven
 * the yt-dlp-missing error.
 *
 * Runs LAST in the alphabetical single-worker order, deliberately: the background compile that
 * follows conversion pops turns off the shared scripted model, and tutor-loop.e2e.ts's own turn
 * sequence must be finished before that happens. The assertion here is the INGEST path (URL ->
 * captions -> transcript on disk -> ledger row); compile outcomes are other tests' business.
 */
test('a pasted YouTube URL becomes a timestamped transcript through Add material', async ({ page }) => {
  await page.goto('/#/t/e2e-video-ingest');
  await page.getByRole('button', { name: /add material/i }).click();
  const dialog = page.getByRole('dialog', { name: /add material/i });
  await expect(dialog).toBeVisible();

  await page.getByLabel(/git url, a youtube link, or a local folder path/i)
    .fill('https://www.youtube.com/watch?v=fakeE2E01');
  const ingest = page.waitForResponse((res) => res.url().endsWith('/api/ingest'));
  await dialog.getByRole('button', { name: /^add$/i }).click();
  const res = await ingest;
  expect(res.ok()).toBe(true);
  expect(await res.json()).toMatchObject({ book: 'Signals and Boundaries', converting: true });

  // Success routes attention to the Library, where the new book's row lives.
  await expect(page.getByRole('tab', { name: 'library', selected: true })).toBeVisible();
  await expect(page.locator('#panel-library').getByText('Signals and Boundaries').first())
    .toBeVisible({ timeout: 10000 });

  // Disk truth: the transcript arrived timestamped, with stamps as deep links into the video.
  const raw = readFileSync(
    join(process.env.E2E_VAULT!, 'raw', 'uploads', 'signals-and-boundaries', 'paper.md'), 'utf8');
  expect(raw).toContain('# Signals and Boundaries');
  expect(raw).toContain('a boundary is where a signal changes meaning');
  expect(raw).toContain('(https://www.youtube.com/watch?v=fakeE2E01&t=2s)');
});
