import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Full loop, driven entirely by the real client: bootstrap -> quick_check block -> answer (click)
 * -> the real client auto-resubmits -> server grades + records evidence -> grading round-trips
 * back to the browser -> turn-2 text renders.
 *
 * Real backend (src/server/index.ts) + real Engram MCP server (fake embeddings, fixture vault
 * from global-setup.ts) + a scripted tutor model (tests/e2e/scripted-model.cjs, wired in via the
 * LW_MOCK_MODEL env hook in src/server/models.ts) + the real built SPA driven by an actual browser.
 *
 * T13 note: this replaces the T12 workaround that issued the follow-up turn via
 * `page.request.post()` directly, bypassing the browser's own resubmit. That workaround existed
 * because two real bugs blocked the real loop:
 *   Bug 1 — useChatRuntime() had no `sendAutomaticallyWhen`, so answering the block never
 *     resubmitted to /api/chat at all. Fixed in src/client/runtime.tsx with a predicate that only
 *     considers BLOCK tool parts in the LAST STEP of the last assistant message (not server-side
 *     MCP tool parts like record_evidence, and not block parts carried forward from an earlier
 *     step — see the predicate's own comment for why step-scoping is required, discovered by
 *     driving this exact test manually before the fix). Also required a server-side fix
 *     (src/server/session.ts's `originalMessages` wired into `createUIMessageStream`) so the
 *     harness's follow-up turn continues the SAME assistant message the client is tracking,
 *     instead of the client and server ending up with duplicate copies of turn-1's content.
 *   Bug 2 — the server graded pending block outputs by mutating its own request-side copy
 *     (session.ts's `p.output.grading = grading`), which the browser never saw. Fixed by writing a
 *     `tool-output-available` chunk for the graded toolCallId as part of the SAME continuation
 *     stream (Bug 1's fix makes this land on the right message part automatically — no custom data
 *     part or client-side merge code needed).
 * Both are now exercised for real: the browser answers the block, resubmits on its own, and
 * renders the graded verdict it received back from the server.
 */
test('full loop: bootstrap → quick_check → answer → auto-resubmit → evidence recorded', async ({ page }) => {
  let chatRequestCount = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/chat')) chatRequestCount++;
  });

  const firstChat = page.waitForResponse((res) => res.url().endsWith('/api/chat'));
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Ask your tutor…' }).fill('hi');
  await page.keyboard.press('Enter');
  await firstChat;

  // Real block UI, really answered. This fires addResult -> addToolOutput, which (Bug 1 fix) makes
  // the client's sendAutomaticallyWhen predicate see a completed block tool part and resubmit on
  // its own — no manual request construction.
  const followUp = page.waitForResponse((res) => res.url().endsWith('/api/chat'));
  await page.getByRole('button', { name: 'slope at a point' }).click();
  await expect(page.getByText('You: slope at a point')).toBeVisible();
  await followUp;

  // (a) Turn-2 text from the harness's graded follow-up turn appears in the DOM — and exactly
  // once: turn-1's own text ("Let's warm up.") must also not be duplicated (the T12 "duplicated
  // message content" bug — see Bug 1's note above).
  // exact:true both times: the focus rail (a later feature) mirrors the tutor's last line into a
  // hidden .focus-rail-lastline whose text CONTAINS both strings — substring matching now resolves
  // to two elements and trips strict mode. The real message paragraphs match exactly; the rail's
  // concatenated mirror does not.
  await expect(page.getByText('Correct! Recorded — nice.', { exact: true })).toBeVisible();
  await expect(page.getByText("Let's warm up.", { exact: true })).toBeVisible();

  // (c) QuickCheck renders the graded verdict it received back over the tool-output-available
  // chunk (Bug 2 fix) — confirms the round-trip actually reached the component, not just the log.
  await expect(page.locator('.verdict.correct')).toBeVisible();

  // Give the client a moment to decide whether to auto-resubmit again — it must not: the
  // follow-up assistant message's new step has a record_evidence part (server-side MCP tool) and
  // text, but no BLOCK tool parts, so the (Bug 1 fix) predicate goes false and the loop terminates.
  await page.waitForTimeout(1000);
  expect(chatRequestCount, 'exactly one auto-resubmit — no runaway loop').toBe(2);

  // (b) Regression guard against the T12 runaway loop (evidence recorded 6x under the stock
  // sendAutomaticallyWhen predicate): exactly ONE evidence entry, from the one legitimate
  // record_evidence call script.json's turn 2 makes.
  const studentFile = JSON.parse(readFileSync(process.env.E2E_VAULT + '/students/e2e.json', 'utf8'));
  expect(studentFile.derivatives.evidence).toHaveLength(1);
  expect(studentFile.derivatives.evidence[0]).toMatchObject({ kind: 'applied-correctly', note: 'quick check' });
});
