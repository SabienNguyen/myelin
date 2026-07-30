import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Everything the e2e suite touches is derived from THIS file's location — the repo root — so a
// fresh clone runs the suite wherever it sits, instead of only on the one machine whose home dir
// the paths used to be baked against (`~/Dev/personal/…`). E2E_DIR/ENGRAM_SRC are handed to the
// backend servers via each webServer's `env` and expanded by the harness config loader's `${VAR}`
// rule; global-setup.ts and the specs derive the same paths from their own import.meta.url.
const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = join(REPO_ROOT, 'tests', 'e2e');
// Where the core is checked out, mirroring resolveEngram()'s search: a sibling (dev machines),
// a child (CI uses `actions/checkout` with `path: engram`, landing it inside the workspace), and
// the pre-rename `loreweaver` name for a checkout that predates the Engram rename. First match wins.
const ENGRAM_SRC = [
  join(REPO_ROOT, '..', 'engram', 'src', 'server.ts'),
  join(REPO_ROOT, 'engram', 'src', 'server.ts'),
  join(REPO_ROOT, '..', 'loreweaver', 'src', 'server.ts'),
  join(REPO_ROOT, 'loreweaver', 'src', 'server.ts'),
].find(existsSync) ?? join(REPO_ROOT, '..', 'engram', 'src', 'server.ts');
// The env the harness backends read the portable fixture paths from (config `${E2E_DIR}` etc.).
const backendEnv = { E2E_DIR, ENGRAM_SRC };

// Where global-setup.ts writes the fake microphone WAV, and where the launch args point Chromium.
export const FAKE_AUDIO_WAV = join(E2E_DIR, '.tmp-fake-audio.wav');

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
    // Fake microphone for the pronounce spec: Chromium plays a WAV file as the mic input, so the
    // recorded audio is deterministic. global-setup.ts writes that WAV (a steady tone) before any
    // test runs. `use-fake-ui-for-media-stream` auto-accepts the mic permission prompt. Harmless to
    // every other spec — they never call getUserMedia. FAKE_AUDIO_WAV is the agreed path.
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${FAKE_AUDIO_WAV}`,
      ],
    },
  },
  webServer: [
    {
      // Real backend + real Engram MCP server (fake embeddings) + scripted model.
      // fake-bin leads PATH so video-ingest.e2e.ts's Add-material drive resolves the fake yt-dlp
      // (tests/e2e/fake-bin/yt-dlp) — captions with no network, same observable surface.
      command:
        'PATH="$PWD/tests/e2e/fake-bin:$PATH" LW_MOCK_MODEL=tests/e2e/script.json HARNESS_CONFIG=tests/e2e/e2e.config.json npx tsx src/server/index.ts',
      port: 4820,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: backendEnv,
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
      env: backendEnv,
    },
    // label-diagram.e2e.ts gets its own pair for the same turn-counter reason as I3 above.
    {
      command:
        'LW_MOCK_MODEL=tests/e2e/label-script.json HARNESS_CONFIG=tests/e2e/label.config.json npx tsx src/server/index.ts',
      port: 4822,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: backendEnv,
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
    // pronounce.e2e.ts gets its own pair for the same turn-counter reason as the specs above.
    // Backend port 4823 comes from pronounce.config.json; the frontend proxies /api there.
    {
      command:
        'LW_MOCK_MODEL=tests/e2e/pronounce-script.json HARNESS_CONFIG=tests/e2e/pronounce.config.json npx tsx src/server/index.ts',
      port: 4823,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: backendEnv,
    },
    {
      command:
        'HARNESS_API=http://localhost:4823 sh -c "npx vite build --outDir dist-pronounce '
        + '&& npx vite preview --outDir dist-pronounce --port 4177 --strictPort"',
      port: 4177,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    // rails.e2e.ts gets its own pair for the same turn-counter reason as the specs above.
    // rails.config.json flips models.tutor.rails on, so this backend's teaching modes run the
    // harness-driven loop against the scripted generation turns in rails-script.json.
    {
      command:
        'LW_MOCK_MODEL=tests/e2e/rails-script.json HARNESS_CONFIG=tests/e2e/rails.config.json npx tsx src/server/index.ts',
      port: 4824,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: backendEnv,
    },
    {
      command:
        'HARNESS_API=http://localhost:4824 sh -c "npx vite build --outDir dist-rails '
        + '&& npx vite preview --outDir dist-rails --port 4178 --strictPort"',
      port: 4178,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
