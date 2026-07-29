---
name: browser-verify
description: Boot this app and drive it in a real Chromium browser to verify a UI change actually works — navigate, click, type, screenshot, read console errors. Use whenever a change touches src/client and you need to see it rendered rather than infer it from tests, when asked to screenshot the app or check how something looks, or when a Playwright e2e test fails and you need to reproduce it interactively. Covers the no-API-key fixture stack, the pinned-Chromium escape hatch, and the known failures so you do not misread them as your own regression.
---

# Browser Verify

You can run this app and look at it. Do that before claiming a UI change works — a passing unit test
does not prove a panel renders.

Playwright is already a dependency (`@playwright/test`) with a configured suite in `tests/e2e/`
(`npm run e2e`). This skill covers both the suite and **ad-hoc driving**, which is what you want when
verifying a change or taking a screenshot.

## The stack boots without an API key

The e2e fixture config replaces every model with a scripted one, so nothing calls Anthropic:

- `tests/e2e/e2e.config.json` — all five roles set to `"scripted"`, embeddings `fake`, student `e2e`,
  a disposable fixture vault, port 4820.
- `LW_MOCK_MODEL=tests/e2e/script.json` — the env hook in `src/server/models.ts` that swaps in
  `tests/e2e/scripted-model.cjs`.

No `ANTHROPIC_API_KEY`, no Ollama, no Anki, no the-gap sidecar required.

## One-time environment setup

**1. Install dependencies in BOTH repos.** The harness spawns Engram as a child process
(`npx tsx <engram>/src/server.ts`), so Engram needs its own `node_modules`:

```bash
cd <harness> && npm install
cd <engram> && npm install
```

**2. Engram must be a sibling checkout.** The e2e configs and integration tests no longer bake
in one machine's home directory — they resolve the vault relative to the repo (`${E2E_DIR}`, set by
`playwright.config.ts`) and the Engram entrypoint as `../engram/src/server.ts` (via
`tests/lwRepo.ts` and `${ENGRAM_SRC}`). So the only requirement is that `engram` sits
alongside `myelin`; no `~/Dev/personal` symlink is needed. If your Engram lives
elsewhere, either place a sibling symlink or set `ENGRAM_ENTRY` (see `src/server/config.ts`):

```bash
# only if engram is NOT already a sibling of myelin
ln -sfn /path/to/engram ../engram
```

**3. Pinned-Chromium sandboxes.** If the image ships a Chromium build under
`PLAYWRIGHT_BROWSERS_PATH` that does not match what this `@playwright/test` version wants, launch
dies with `Executable doesn't exist at .../chromium_headless_shell-<n>/...`. Such images normally
forbid `npx playwright install`. Point Playwright at the browser that IS present:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run e2e
```

`playwright.config.ts` reads that variable and sets `launchOptions.executablePath` only when it is
set, so a normal dev machine is unaffected. For an ad-hoc script, pass
`chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })`.

## Running the suite

```bash
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test --reporter=list
```

Playwright starts **all four** `webServer` entries (two backends, two `vite build` + `vite preview`
pairs), so a cold run takes a couple of minutes. To iterate on one file, still expect all four to
boot — that is how the config is written.

### Known results — do not mistake these for your regression

The suite currently runs **all 10 tests green** (verified). The two entries below were once a
documented skip and a documented failure; both are now resolved. They are kept here so that if
either reappears you recognise it as a REAL regression, not the old baseline:

- `gap-exercise.e2e.ts` and `gap-help.e2e.ts` **run and pass** — they exercise the BUILT-IN sandbox,
  which serves `/api/gap/*` from the backend process itself, so there is no external the-gap sidecar
  on `:4930` to gate on. (The old external-sidecar version `test.skip()`ped when `:4930` went
  unanswered; that dependency is gone — see gap-exercise.e2e.ts's own "No skip" comment.) If these
  start skipping or failing, suspect a broken built-in sandbox, not a missing sidecar.
- `tutor-loop.e2e.ts` **passes** — the old strict-mode violation (a bare
  `getByText('Correct! Recorded — nice.')` matched both the real transcript `<p>` and `FocusRail`'s
  hidden `.focus-rail-lastline` mirror) was fixed by asserting with `{ exact: true }`, which the
  rail's longer containing text no longer satisfies. A re-broadened locator would bring it back.
- `graph-contextual.e2e.ts` passes.

## Ad-hoc driving (the useful mode)

Boot the two servers yourself, then script the browser. `dist/` must exist — run `npx vite build`
once if it does not.

```bash
LW_MOCK_MODEL=tests/e2e/script.json HARNESS_CONFIG=tests/e2e/e2e.config.json \
  npx tsx src/server/index.ts > /tmp/backend.log 2>&1 &
npx vite preview --port 4173 --strictPort > /tmp/preview.log 2>&1 &
sleep 10
curl -s localhost:4820/api/status   # {"student":"e2e","tutor":"scripted",...}
```

Then a throwaway script. **Put it inside the repo root**, not a temp directory — Node resolves
`@playwright/test` from the script's own location, so a script in `/tmp` fails with
`ERR_MODULE_NOT_FOUND`.

```js
import { chromium } from '@playwright/test';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
p.on('console', m => m.type() === 'error' && console.log('[console.error]', m.text()));
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await p.getByPlaceholder(/Ask your tutor/i).fill('hi');
await p.keyboard.press('Enter');
await p.waitForTimeout(6000);
await p.screenshot({ path: '/tmp/ui.png', fullPage: true });
await p.getByRole('tab', { name: 'graph' }).click();
await b.close();
```

Delete the script when done. Then **read the screenshot** — do not just assert it was written.

Stop the servers by pid, not with a broad `pkill` (a loose pattern can kill your own shell):

```bash
for p in $(ps -eo pid,args | grep "tsx src/server/index.ts" | grep -v grep | awk '{print $1}'); do kill $p; done
```

## What to check once you are in the browser

- Query by role and accessible name — `getByRole('tab', { name: 'graph' })` — as the client tests do.
  If a control is unreachable that way, that is an accessibility bug in the component.
- Watch `console.error` and `pageerror`. A silent React error is easy to miss in a screenshot.
- Check **both colour schemes**. `design.md` requires dark mode to work:
  `await p.emulateMedia({ colorScheme: 'dark' })`, then screenshot again.
- Check a narrow viewport if you touched layout.
- Compare what you see against `design.md` and the `no-slop-ui` skill — warm paper palette, Fraunces
  display type, no gradients, no emoji, visible focus rings.

## Honesty rule

If you did not run the browser, do not say the UI works. If a screenshot shows something off, say so
even when the tests pass.
