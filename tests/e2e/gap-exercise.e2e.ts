import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GAP_REPO = join(homedir(), 'Dev/personal/the-gap');

/**
 * Fetches the REAL reference answer for stream-consumer's full_body rung, test-side, straight
 * from the-gap's masker CLI — never through the UI payload (the whole point of I2's
 * reference_answer-stripping proxy is that the browser never receives this string). Command per
 * the-gap's packages/masker/src/cli.ts doc: `pnpm --filter masker mask <artifactId> <template>
 * '<selectorJSON>'` prints the Rung as JSON to stdout, exit 0 — `--silent` suppresses pnpm's own
 * command echo, which would otherwise precede the JSON on stdout and break JSON.parse.
 */
async function fetchReferenceAnswer(): Promise<string> {
  const { stdout } = await execFileAsync(
    'npm',
    [
      'exec', '--yes', 'pnpm@latest', '--', '--filter', 'masker', '--silent', 'mask',
      'stream-consumer', 'full_body', '{"kind":"function_body","name":"consumeStream"}',
    ],
    { cwd: GAP_REPO, timeout: 60_000 },
  );
  const rung = JSON.parse(stdout.trim());
  if (typeof rung.reference_answer !== 'string' || !rung.reference_answer.trim()) {
    throw new Error(`masker returned no reference_answer: ${stdout.slice(0, 200)}`);
  }
  return rung.reference_answer as string;
}

// This file's dedicated backend+frontend pair (playwright.config.ts) serves on :4174/:4821 —
// see that config's comment for why gap-exercise.e2e.ts doesn't share tutor-loop.e2e.ts's
// :4173/:4820 pair.
test.use({ baseURL: 'http://localhost:4174' });

test('code_exercise: real gap sidecar renders the full_body editor, the reference answer passes '
  + 'real tests, and applied-correctly evidence lands in the vault', async ({ page }) => {
  // I3 (docs/superpowers/plans/2026-07-20-gap-integration.md): "prefer REAL sidecar ... if
  // unavailable, skip with a clear message rather than mock" — global-setup.ts pings :4930 once
  // for the whole run.
  test.skip(
    !process.env.E2E_GAP_SIDECAR_UP,
    'the-gap sidecar not reachable on :4930 (systemd --user the-gap.service) — skipping rather '
      + 'than mocking the real service; start it and re-run to exercise this test.',
  );
  test.setTimeout(90_000);

  const referenceAnswer = await fetchReferenceAnswer();

  const firstChat = page.waitForResponse((res) => res.url().endsWith('/api/chat'));
  await page.goto('/');
  await page.getByPlaceholder('Ask your tutor…').fill('Practice stream-consumer with a code exercise');
  await page.keyboard.press('Enter');
  await firstChat;

  // (1) Chat proof: the scripted turn's code_exercise tool call rendered as the chip (Stage
  // auto-switches via StagePortal's mount effect — see CodeExercise.tsx).
  const chip = page.getByRole('button', { name: /code exercise waiting on the stage/i });
  await expect(chip).toBeVisible();
  await page.screenshot({ path: '/tmp/i3-1.png', fullPage: true });

  // (2) Stage proof: full_body is a single rung (not 'ladder'), so the real CM6 editor — fed by
  // the REAL sidecar's rung data through the harness proxy — mounts directly, no ladder nav.
  const gapEditor = page.getByTestId('gap-editor').locator('.cm-content');
  await expect(gapEditor).toBeVisible();
  await page.screenshot({ path: '/tmp/i3-2.png', fullPage: true });

  // Real editor, exact content: dispatch a synthetic ClipboardEvent('paste') at the CM6 content
  // node — CM6's own paste handler applies it as one transaction (see RungEditor.tsx's
  // data-testid doc comment for why paste, not page.keyboard.type, drives this: closeBrackets'
  // type-over heuristic isn't reliable for exact multi-line reproduction of code containing
  // strings/brackets). Matched on request body (not just the URL) because an empty-code auto-run
  // can also fire from useDebouncedRun on mount, before this paste.
  const passingRun = page.waitForResponse(async (res) => {
    if (!res.url().endsWith('/api/gap/run')) return false;
    const body = res.request().postDataJSON();
    return typeof body?.code === 'string' && body.code.trim().length > 0;
  });
  await gapEditor.click();
  await gapEditor.evaluate((el, text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text as string);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, referenceAnswer);

  const runRes = await passingRun;
  const runBody = await runRes.json();
  // Sanity: the reference answer really does pass the REAL sidecar's real tests (not a stub).
  expect(runBody.pass, `expected the-gap's own reference answer to pass: ${JSON.stringify(runBody)}`).toBe(true);

  // Passing fires addResult -> the client's sendAutomaticallyWhen predicate auto-resubmits (the
  // same real loop tutor-loop.e2e.ts exercises for quick_check) -> scripted turn 2 calls
  // record_evidence.
  const followUp = page.waitForResponse((res) => res.url().endsWith('/api/chat'));
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
  await expect(page.getByText('Nice — your own code passed the real tests.')).toBeVisible();
  await expect(page.locator('.code-exercise.done .graded-tag')).toBeVisible();
  await page.screenshot({ path: '/tmp/i3-3.png', fullPage: true });

  // Definition of done (I3): applied-correctly evidence landed in the TEMP vault's student file
  // for slug 'stream-consumer'.
  const gapVault = process.env.E2E_GAP_VAULT!;
  const studentFile = JSON.parse(readFileSync(join(gapVault, 'students', 'e2e.json'), 'utf8'));
  const evidence = studentFile['stream-consumer']?.evidence ?? [];
  expect(evidence.some((e: { kind: string }) => e.kind === 'applied-correctly')).toBe(true);
});
