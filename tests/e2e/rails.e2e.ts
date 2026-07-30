import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Rails mode end to end (docs/superpowers/specs/2026-07-30-rails-mode.md), driven by the real
 * client against a backend booted with models.tutor.rails: true (rails.config.json). The model
 * side is only the two narrow generation calls in rails-script.json — the plan (working_set +
 * next_lessons), the staging, the grading, and record_evidence are all the HARNESS's own work,
 * which is exactly what the evidence assertion proves: the scripted model never calls
 * record_evidence, yet the vault ends up with the entry, exactly once.
 * Own backend pair (:4824/:4178) for the scripted-turn-counter reason the other specs document.
 */
const RAILS_VAULT = join(dirname(fileURLToPath(import.meta.url)), '.tmp-vault-rails');

test('rails: plan → staged quick_check → answer → harness-recorded evidence → feedback', async ({ page }) => {
  let chatRequestCount = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/chat')) chatRequestCount++;
  });

  const firstChat = page.waitForResponse((res) => res.url().endsWith('/api/chat'));
  await page.goto('http://localhost:4178/');
  await page.getByRole('textbox', { name: 'Ask your tutor…' }).fill('drill me');
  await page.keyboard.press('Enter');
  await firstChat;

  // The staged block renders like any model-staged quick_check: framing line, then the choices.
  // .last(): the focus rail mirrors the tutor's last line verbatim, so the text appears twice
  // (same reason history.e2e.ts uses it — a lone framing line has no concatenation to disambiguate).
  await expect(page.getByText('First contact — you are not expected to know this yet; a guess shows where to start.', { exact: true }).last()).toBeVisible();

  const followUp = page.waitForResponse((res) => res.url().endsWith('/api/chat'));
  await page.getByRole('button', { name: 'slope at a point' }).click();
  await expect(page.getByText('You: slope at a point')).toBeVisible();
  await followUp;

  // The grading round-trip reached the card, and the scripted feedback plus the harness's own
  // stop-offer line rendered (rails-script.json's turn 2 says next: 'stop-offer').
  await expect(page.locator('.verdict.correct')).toBeVisible();
  await expect(page.getByText('You picked "slope at a point" — the machine grade agrees.', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('Stop here, or keep going? Say "go on" for another.', { exact: true }).last()).toBeVisible();

  // stop-offer stages no new block, so the auto-resubmit predicate must go false: exactly one
  // resubmit, no runaway loop.
  await page.waitForTimeout(1000);
  expect(chatRequestCount, 'exactly one auto-resubmit').toBe(2);

  // THE rails invariant: evidence in the vault exactly once, recorded by the harness — the
  // scripted model's two turns are generation-only and never call record_evidence.
  const student = JSON.parse(readFileSync(join(RAILS_VAULT, 'students', 'e2e.json'), 'utf8'));
  expect(student.derivatives.evidence).toHaveLength(1);
  expect(student.derivatives.evidence[0]).toMatchObject({ kind: 'applied-correctly' });

  // The saved thread survives a reload — createUiStream's onEnd + the client PUT both persist it.
  await page.reload();
  await expect(page.getByText('What does a derivative measure?').first()).toBeVisible();
  await expect(page.locator('.verdict.correct')).toBeVisible();
});
