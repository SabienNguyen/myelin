import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Named *.e2e.ts (not the Playwright/vitest-default *.spec.ts) so `vitest run` — whose default
  // include glob is any *.spec.ts / *.test.ts in the repo — doesn't try to load a file that calls
  // @playwright/test's test() outside a Playwright runner. vitest.config.ts is out of scope here,
  // so this file is named to avoid the collision instead.
  testMatch: '**/*.e2e.ts',
  timeout: 45_000,
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  // I3 added a second test file (gap-exercise.e2e.ts) with its own dedicated backend+frontend
  // pair (see the webServer comment below). fullyParallel:false only serializes tests WITHIN one
  // file — different files still run concurrently across Playwright's default worker pool, which
  // both wastes CPU (this project runs 4 dev servers instead of 2 for the whole suite) and, worse,
  // was observed to starve the other file's page.goto()/navigation past its timeout under that
  // contention. One worker keeps the whole e2e run strictly sequential.
  workers: 1,
  use: {
    baseURL: 'http://localhost:4173',
    // Escape hatch for sandboxes/CI images that ship a PINNED Chromium build under
    // PLAYWRIGHT_BROWSERS_PATH which doesn't match the build this @playwright/test version wants
    // (e.g. a 1194 image against playwright 1.61.1, which looks for 1228 and dies with
    // "Executable doesn't exist"). Those images forbid `npx playwright install`, so point this at
    // the browser they DO ship — `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run e2e`.
    // Unset (a normal dev machine, browsers installed by playwright itself) -> no launchOptions
    // override at all, so the default resolution is untouched.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },
  webServer: [
    {
      // Real backend + real Loreweaver MCP server (fake embeddings) + scripted model.
      // fake-bin leads PATH so video-ingest.e2e.ts's Add-material drive resolves the fake yt-dlp
      // (tests/e2e/fake-bin/yt-dlp) — captions with no network, same observable surface.
      command:
        'PATH="$PWD/tests/e2e/fake-bin:$PATH" LW_MOCK_MODEL=tests/e2e/script.json HARNESS_CONFIG=tests/e2e/e2e.config.json npx tsx src/server/index.ts',
      port: 4820,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // Build then serve the SPA; vite.config.ts's server.proxy is inherited by `vite preview`
      // (preview.proxy falls back to server.proxy — see node_modules/vite/dist/node/chunks/node.js),
      // so /api/* already reaches the harness server on :4820 with no extra config.
      command: 'npx vite build && npx vite preview --port 4173 --strictPort',
      port: 4173,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    // I3 (docs/superpowers/plans/2026-07-20-gap-integration.md): tests/e2e/gap-exercise.e2e.ts
    // gets its OWN backend+frontend pair on distinct ports rather than sharing the two servers
    // above. Reason: the scripted model (tests/e2e/scripted-model.cjs) is created ONCE per server
    // boot inside createTutorSession (src/server/session.ts) and its script-turn index is a
    // running counter for the LIFE OF THAT PROCESS, shared by every /api/chat request the process
    // ever serves — fine within one test file's fixed number of turns, but fragile to reason about
    // across two independent test files sharing one process (turn-index arithmetic would depend on
    // file execution order). A dedicated backend (its own gap-script.json, its own turn-index
    // counter) sidesteps that entirely instead of relying on it. gap.config.json's `gap.url` points
    // at the REAL the-gap sidecar on :4930 (started by systemd, NOT by Playwright) — see
    // global-setup.ts's isGapSidecarUp()/E2E_GAP_SIDECAR_UP; the test skips with a clear message
    // rather than mocking it when that sidecar isn't reachable.
    {
      command:
        'LW_MOCK_MODEL=tests/e2e/gap-script.json HARNESS_CONFIG=tests/e2e/gap.config.json npx tsx src/server/index.ts',
      port: 4821,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    // label-diagram.e2e.ts gets its own pair for the same turn-counter reason as I3 above.
    {
      command:
        'LW_MOCK_MODEL=tests/e2e/label-script.json HARNESS_CONFIG=tests/e2e/label.config.json npx tsx src/server/index.ts',
      port: 4822,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // Separate --outDir (dist-gap, not dist) so this build never races the other frontend
      // entry's concurrent `vite build` writing the same directory — Playwright starts every
      // webServer entry in parallel. HARNESS_API repoints the built SPA's /api proxy at the
      // dedicated :4821 backend above instead of vite.config.ts's :4820 default.
      command:
        'HARNESS_API=http://localhost:4821 sh -c "npx vite build --outDir dist-gap '
        + '&& npx vite preview --outDir dist-gap --port 4174 --strictPort"',
      port: 4174,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command:
        'HARNESS_API=http://localhost:4822 sh -c "npx vite build --outDir dist-label '
        + '&& npx vite preview --outDir dist-label --port 4175 --strictPort"',
      port: 4175,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
