import { test, expect } from '@playwright/test';

/**
 * Chat first, study on demand (docs/superpowers/plans/2026-09-22-chat-first.md), in a real browser
 * against the real backend and Engram, on the chat pair (:4824/:4178). Its script is keyed
 * (tests/e2e/chat-script.json, scripted-model.cjs's `when`), so each reply below answers the
 * message that asked for it, whatever else the backend served before.
 *
 * What is being proved is the chat default end to end: a greeting is answered as a greeting (no
 * lesson, no block), an answer offers the two quiet ways into study, "check my understanding"
 * stages a real block, and /study from the slash menu turns the tutor on until `end` turns it off.
 */
test.use({ baseURL: 'http://localhost:4178' });

test('a greeting gets a greeting, an answer offers study, and /study is sticky until ended', async ({ page }) => {
  await page.goto(`/#/t/chat-first-${Date.now()}`);
  await expect(page.getByRole('heading', { name: 'What do you want to explore?' })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Ask your tutor…' });
  const transcript = page.getByLabel('Conversation transcript');

  // A greeting: a greeting back, and nothing staged or offered on top of it.
  await composer.fill('hello there');
  await page.keyboard.press('Enter');
  await expect(transcript.getByText('Hi — what would you like to explore today?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'check my understanding' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'end study session' })).toHaveCount(0);

  // A real answer carries the two ways into study beneath it.
  await composer.fill('what is a derivative?');
  await page.keyboard.press('Enter');
  await expect(transcript.getByText(/A derivative measures how fast a function changes/)).toBeVisible();
  const check = page.getByRole('button', { name: 'check my understanding' });
  await expect(check).toBeVisible();
  await expect(page.getByRole('button', { name: 'study this' })).toBeVisible();

  // "check my understanding" is a plain chat message, and the turn it starts stages a block.
  const checkRequest = page.waitForRequest((r) => r.url().endsWith('/api/chat') && r.method() === 'POST');
  await check.click();
  const checkBody = (await checkRequest).postDataJSON();
  expect(checkBody.command).toBeUndefined();
  expect(checkBody.mode).toBeUndefined();
  await expect(page.getByRole('button', { name: 'the slope of the tangent' })).toBeVisible();

  // /study from the slash menu: a command chip, then the topic.
  await composer.click();
  await page.keyboard.type('/stu');
  await expect(page.getByRole('option', { name: /\/study/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('teach me limits properly');
  const studyRequest = page.waitForRequest((r) => r.url().endsWith('/api/chat') && r.method() === 'POST');
  await page.keyboard.press('Enter');
  expect((await studyRequest).postDataJSON().command).toBe('study');
  await expect(transcript.getByText(/Limits, step by step/)).toBeVisible();

  // Studying: the composer says so and can end it; chat's chips step aside meanwhile.
  const end = page.getByRole('button', { name: 'end study session' });
  await expect(end).toBeVisible();
  await expect(page.getByText('studying', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'study this' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/chat-first-studying.png', fullPage: true });

  await end.click();
  await expect(end).toHaveCount(0);
});
