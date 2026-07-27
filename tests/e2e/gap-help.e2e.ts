import { test, expect } from '@playwright/test';

// Track A (docs/superpowers/plans/2026-07-21-coding-stage.md "A. In-IDE tutor help"): drives the
// SAME dedicated backend+frontend pair (:4821/:4174) as gap-exercise.e2e.ts — see that file's top
// comment and playwright.config.ts's webServer doc for why this pair is separate from the
// prod-shaped :4820/:4173 pair (never touched here).
//
// The scripted model (tests/e2e/scripted-model.cjs) only implements doStream() — its doGenerate()
// throws by design ("the harness only ever calls doStream", per that file's doc comment). Chat
// turns go through streamText (doStream), so the existing script drives them fine, but
// gapHelp.ts's ai-sdk/ollama: dispatch path calls `generateText`, which calls doGenerate — the
// scripted model genuinely cannot drive tutor-model help generation. Per the spec's own fallback
// instruction, this test stubs POST /api/gap/help at the network layer (page.route) instead of
// relying on the scripted model for that one call. Everything else (loading the real ladder from
// the-gap sidecar on :4930, opening focus mode via a real scripted chat turn, the Help tab UI, the
// markdown render, the transcript) is exercised for real.
test.use({ baseURL: 'http://localhost:4174' });

test('Help tab: composer submits, a hint exchange renders in the transcript inside focus mode', async ({ page }) => {
  // No skip: the built-in sandbox (src/server/gap/) serves /api/gap/* from the backend process
  // itself — there is no external sidecar to be down.
  test.setTimeout(60_000);

  const STUBBED_HINT = 'Name what should happen when `response.body` is null before anything '
    + 'tries to call `.getReader()` on it — nothing currently checks for that case.';

  await page.route('**/api/gap/help', async (route) => {
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({ pattern: 'stream-consumer', rung: 'full_body' });
    expect(typeof body.question).toBe('string');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hint: STUBBED_HINT }),
    });
  });

  const firstChat = page.waitForResponse((res) => res.url().endsWith('/api/chat'));
  // Own thread, deliberately: gap-exercise.e2e.ts runs first against the SAME backend and leaves
  // its finished conversation in the default thread. The scripted model pops turns off one global
  // counter (scripted-model.cjs), so this test's one chat turn consumes script turn 3 — the
  // staging turn added for it — and a fresh thread keeps that staging the only thing on stage.
  await page.goto('/#/t/e2e-gap-help');
  await page.getByPlaceholder('Ask your tutor…').fill('Practice stream-consumer with a code exercise');
  await page.keyboard.press('Enter');
  await firstChat;

  // Same real full_body screen gap-exercise.e2e.ts asserts against. The predict-before-write
  // gate stands between staging and the editor; this test's subject is the Help tab, and
  // gap-exercise already answers the gate for real, so skipping is the honest shortcut here.
  await page.getByRole('button', { name: 'skip', exact: true }).click();
  const gapEditor = page.getByTestId('gap-editor').locator('.cm-content');
  await expect(gapEditor).toBeVisible();

  await page.getByRole('tab', { name: /help/i }).click();
  const composer = page.getByPlaceholder('ask about this exercise…');
  await expect(composer).toBeVisible();

  const helpRequest = page.waitForResponse((res) => res.url().endsWith('/api/gap/help'));
  await composer.fill('why does the null-body test still fail?');
  await page.getByRole('button', { name: /^ask$/i }).click();
  await helpRequest;

  await expect(page.getByText('why does the null-body test still fail?')).toBeVisible();
  await expect(page.getByText(/nothing currently checks for that case/)).toBeVisible();

  await page.screenshot({
    path: '/tmp/claude-1000/-home-sabien-Dev-personal/a2271c77-9198-4cbf-ad90-dfbaa799d9d9/scratchpad/help-tab.png',
    fullPage: true,
  });
});
