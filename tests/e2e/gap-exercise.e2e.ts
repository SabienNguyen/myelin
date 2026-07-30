import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STREAM_CONSUMER_RUNGS, runnableReference } from '../../src/server/gap/streamConsumer.js';

/**
 * The REAL reference answer for stream-consumer's full_body rung, test-side, straight from the
 * built-in sandbox's own artifact module — never through the UI payload (the whole point of the
 * reference_answer-stripping invariant is that the browser never receives this string; service.ts
 * strips it before serialization, so reading it here from source is the only honest way to get
 * it). This replaced a shell-out to the external the-gap repo's masker CLI when the built-in
 * sandbox (src/server/gap/) became the default: the artifact and its reference now live in THIS
 * repo, so the test runs anywhere the repo does.
 */
function completeReferenceFile(): string {
  const rung = STREAM_CONSUMER_RUNGS.find((r) => r.template === 'full_body');
  if (!rung) throw new Error('built-in ladder has no full_body rung');
  const file = runnableReference(rung);
  if (!file.trim()) throw new Error('built-in full_body rung has an empty reference');
  return file;
}

// This file's dedicated backend+frontend pair (playwright.config.ts) serves on :4174/:4821 —
// see that config's comment for why gap-exercise.e2e.ts doesn't share tutor-loop.e2e.ts's
// :4173/:4820 pair.
test.use({ baseURL: 'http://localhost:4174' });

test('code_exercise: the built-in sandbox renders the full_body editor, the reference answer '
  + 'passes real tests, and applied-correctly evidence lands in the vault', async ({ page }) => {
  // No skip: the built-in sandbox serves /api/gap/* from the backend process itself. The original
  // external-sidecar version of this test could only run on a machine with the-gap checked out
  // and its systemd service up; the artifact now lives in this repo.
  test.setTimeout(90_000);

  const completeFile = completeReferenceFile();

  const firstChat = page.waitForResponse((res) => res.url().endsWith('/api/chat'));
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Ask your tutor…' }).fill('Practice stream-consumer with a code exercise');
  await page.keyboard.press('Enter');
  await firstChat;

  // (1) Staging proof: the scripted turn's code_exercise tool call mounted the exercise on the
  // stage. Asserted on the STAGE's own content, not the thread-side chip — focus mode collapses
  // the chat column to a rail as soon as the exercise mounts, and whether the chip is still in
  // the tree when this assertion runs is a race the exercise's presence doesn't depend on
  // (observed losing under load; the exercise itself had staged fine).
  await expect(page.locator('#stage-root').getByRole('heading', { name: 'stream-consumer' }))
    .toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: '/tmp/i3-1.png', fullPage: true });

  // Predict-before-write gate (backlog item 4, added after this test was written): the editor
  // does not mount until the learner predicts the finished function's output — or skips. Answer
  // it FOR REAL: the gate's fixture input is `data: a` / `data: [DONE]` / `data: never`, and the
  // whole point of the pattern is that nothing after the sentinel is emitted — so the honest
  // prediction is exactly one line, "a". This drives the server-graded /api/gap/predict path
  // through a real browser rather than clicking skip past it.
  const prediction = page.getByRole('textbox', { name: 'predicted output, one per line' });
  await expect(prediction).toBeVisible();
  await prediction.fill('a');
  await page.getByRole('button', { name: 'check my prediction' }).click();
  // A correct prediction shows its verdict and hands control back explicitly — the learner
  // clicks through when they're ready, the editor doesn't jump-scare in mid-read.
  await page.getByRole('button', { name: 'continue to the editor' }).click();

  // (2) Stage proof: full_body is a single rung (not 'ladder'), so the real CM6 whole-file editor
  // (RungEditor v2, docs/superpowers/plans/2026-07-21-coding-stage.md) — fed by the built-in
  // sandbox's rung data (its `scaffold` field) — mounts once the gate clears, no ladder nav.
  const gapEditor = page.getByTestId('gap-editor').locator('.cm-content');
  await expect(gapEditor).toBeVisible();
  await page.screenshot({ path: '/tmp/i3-2.png', fullPage: true });

  // Real editor, exact content: select the whole doc then dispatch a synthetic ClipboardEvent
  // ('paste') at the CM6 content node — CM6's own paste handler applies it as one transaction
  // (see RungEditor.tsx's data-testid doc comment for why paste, not page.keyboard.type, drives
  // this: closeBrackets' type-over heuristic isn't reliable for exact multi-line reproduction of
  // code containing strings/brackets). The whole-file editor starts pre-loaded with the rung's
  // scaffold (not empty, unlike the old gap-only pane) — selecting everything first is what makes
  // this a REPLACE rather than an insert into the middle of the scaffold. Matched on the exact
  // request body (not just a non-empty heuristic) because RungEditor's own mount-time sync can
  // also fire an auto-run against the untouched scaffold before this paste ever lands.
  const passingRun = page.waitForResponse(async (res) => {
    if (!res.url().endsWith('/api/gap/run')) return false;
    const body = res.request().postDataJSON();
    return body?.mode === 'file' && body?.code === completeFile;
  });
  await gapEditor.click();
  await gapEditor.evaluate((el, text) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const dt = new DataTransfer();
    dt.setData('text/plain', text as string);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, completeFile);

  const runRes = await passingRun;
  const runBody = await runRes.json();
  // Sanity: the reference answer really does pass the REAL sidecar's real tests (not a stub).
  expect(runBody.pass, `expected the-gap's own reference answer to pass: ${JSON.stringify(runBody)}`).toBe(true);

  // P2 (editor polish): Run and Submit are now separate — a passing auto-run alone no longer
  // completes the block (see CodeExercise.tsx's `run()`/`doSubmit()` split). Submit is always
  // clickable, but only completes immediately (no confirm) once React state reflects an
  // all-passing run — `passingRun` above only proves the NETWORK response landed, not that the
  // page's own fetch().then/setState chain has consumed it yet, so wait for the console to
  // actually render zero failing results before clicking (the same state doSubmit() reads).
  await expect(page.locator('.test-result--fail')).toHaveCount(0);
  await expect(page.locator('.test-result--pass').first()).toBeVisible();

  // Submitting fires addResult -> the client's sendAutomaticallyWhen predicate auto-resubmits (the
  // same real loop tutor-loop.e2e.ts exercises for quick_check) -> scripted turn 2 calls
  // record_evidence — register the /api/chat wait BEFORE the click that triggers it.
  const followUp = page.waitForResponse((res) => res.url().endsWith('/api/chat'));
  await page.getByRole('button', { name: 'submit', exact: true }).click();
  const followUpRes = await followUp;
  // Consume the full SSE body before touching the vault file: record_evidence's actual write
  // happens server-side once its execute() resolves, which the stream reports via a
  // tool-output-available chunk that can arrive AFTER the turn's text chunks (the client renders
  // text incrementally as it streams) — waiting only for response-received or for the text to
  // become visible would race the disk write. Playwright taps the response independently of
  // whether the page has finished consuming it, so this is a clean way to know the server-side
  // stream (and therefore the awaited record_evidence call) has fully finished.
  await followUpRes.text();

  // (3) Post-pass proof: the graded chip + turn-2 text from the scripted model's follow-up.
  // Scoped to the actual message thread (not just getByText on the whole page): FocusRail.tsx's
  // collapsed-panel summary (.focus-rail-lastline) joins the two most recent assistant turns'
  // text into one string once focus mode drops on Submit (CodeExerciseInner's unmount effect),
  // so an unscoped getByText for turn 2's text alone resolves ambiguously — it's a substring of
  // BOTH the real message bubble and that joined summary line.
  await expect(page.locator('.thread-viewport').getByText('Nice — your own code passed the real tests.')).toBeVisible();
  await expect(page.locator('.code-exercise.done .graded-tag')).toBeVisible();
  await page.screenshot({ path: '/tmp/i3-3.png', fullPage: true });

  // Definition of done (I3): applied-correctly evidence landed in the TEMP vault's student file
  // for slug 'stream-consumer'.
  const gapVault = process.env.E2E_GAP_VAULT!;
  const studentFile = JSON.parse(readFileSync(join(gapVault, 'students', 'e2e.json'), 'utf8'));
  const evidence = studentFile['stream-consumer']?.evidence ?? [];
  expect(evidence.some((e: { kind: string }) => e.kind === 'applied-correctly')).toBe(true);
});
