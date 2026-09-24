import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Inline asides end to end (docs/superpowers/plans/2026-09-22-inline-asides.md, A3), on the chat
 * pair (:4824/:4178): the learner asks about a phrase of a tutor message without derailing the
 * lesson, the answer lands under that message and survives a reload, and the pending quick_check
 * is still answerable afterwards — its graded turn is where the tutor hears about the aside.
 *
 * The graded turn's scripted reply is keyed on the HARNESS aside note's own words
 * (tests/e2e/chat-script.json, "asked aside questions"): the reply below only renders if that
 * note reached the model's request, so seeing it is the assertion.
 */
test.use({ baseURL: 'http://localhost:4178' });

test('an aside answers under its message, survives reload, and the tutor hears about it at grading', async ({ page }) => {
  const thread = `aside-${Date.now()}`;
  await page.goto(`/#/t/${thread}`);
  const transcript = page.getByLabel('Conversation transcript');

  const first = page.waitForResponse((r) => r.url().endsWith('/api/chat'));
  await page.getByRole('textbox', { name: 'Ask your tutor…' }).fill('quiz me on the chain rule');
  await page.keyboard.press('Enter');
  await first;
  const tutorLine = transcript.getByText(/The chain rule differentiates a composition/);
  await expect(tutorLine).toBeVisible();
  await expect(page.getByRole('button', { name: 'compositions of functions' })).toBeVisible();

  // Select "outer derivative" inside the tutor's message.
  await tutorLine.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf('outer derivative');
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 'outer derivative'.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return;
    }
    throw new Error('"outer derivative" is not in the tutor message');
  });

  const aside = page.waitForResponse((r) => r.url().endsWith('/api/aside'));
  await page.getByRole('button', { name: 'ask aside', exact: true }).click();
  await page.getByRole('textbox', { name: 'aside question' }).fill('why multiply by the inner one?');
  await page.getByRole('button', { name: 'submit' }).click();
  expect((await aside).status()).toBe(200);

  // Collapsed under the message it was asked about; the answer is one click away.
  const summary = transcript.getByText('aside · outer derivative');
  await expect(summary).toBeVisible();
  await summary.click();
  await expect(transcript.getByText(/inner function sets how fast/)).toBeVisible();

  // Persisted on the thread, not just held by this page.
  await page.reload();
  await expect(transcript.getByText('aside · outer derivative')).toBeVisible();

  // The pending block is still answerable, and answering it is an ordinary graded turn.
  const graded = page.waitForResponse((r) => r.url().endsWith('/api/chat'));
  await page.getByRole('button', { name: 'compositions of functions' }).click();
  await (await graded).text();
  await expect(transcript.getByText('Right — compositions. Recorded.', { exact: true })).toBeVisible();

  const studentFile = JSON.parse(readFileSync(join(process.env.E2E_CHAT_VAULT!, 'students', 'e2e.json'), 'utf8'));
  expect(studentFile.derivatives.evidence).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'applied-correctly', note: 'chain rule check' })]),
  );
});
