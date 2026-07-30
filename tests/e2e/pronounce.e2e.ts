import { test, expect } from '@playwright/test';

/**
 * The pronounce block driven through a REAL microphone path — the one flow that can only be proven
 * with a browser. Chromium's fake audio device (playwright.config.ts launchOptions +
 * global-setup.ts's WAV) feeds a steady tone as the mic input, so recording captures a level pitch
 * that grades as ngang deterministically. This is the closest automated coverage to the actual
 * feature: getUserMedia → MediaRecorder → decode → pitchTrack → gradeTone → applied evidence, none
 * of it mocked. Own scripted backend pair (:4823/:4177) for the same turn-counter reason as the
 * label spec.
 */
test('recording a level tone grades ngang and mints applied-correctly evidence', async ({ page }) => {
  const first = page.waitForResponse((r) => r.url().endsWith('/api/chat'));
  await page.goto('http://localhost:4177/');
  await page.getByRole('textbox', { name: 'Ask your tutor…' }).fill('teach me the level tone');
  await page.keyboard.press('Enter');
  await first;

  // The block lives on the Stage; the chat shows a chip that opens it.
  await page.getByRole('button', { name: 'Pronunciation waiting on the stage' }).click();
  await expect(page.locator('.block.pronounce')).toBeVisible();
  await expect(page.locator('.pronounce-tone')).toContainText('ngang (level)');

  // Record the fake mic (the steady tone), then stop. requiredPasses is 1, so one clean pass
  // completes the block and submits — the follow-up scripted turn confirms grading ran.
  const followUp = page.waitForResponse((r) => r.url().endsWith('/api/chat'));
  await page.locator('.pronounce-rec').click();
  await page.waitForTimeout(1200); // ~1.2s of the tone — comfortably more than the min voiced frames
  await page.locator('.pronounce-rec.is-recording').click();
  await followUp;

  // The graded done card, and the tutor's scripted follow-up turn.
  await expect(page.locator('.block.pronounce.done .graded-tag')).toBeVisible();
  await expect(page.getByText('1/1 clean', { exact: false })).toBeVisible();
  await expect(page.getByText('Level and steady — ngang is yours.', { exact: true })).toBeVisible();
});
