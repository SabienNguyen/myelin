import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Named *.e2e.ts (not the Playwright/vitest-default *.spec.ts) so `vitest run` — whose default
  // include glob is any *.spec.ts / *.test.ts in the repo — doesn't try to load a file that calls
  // @playwright/test's test() outside a Playwright runner. vitest.config.ts is out of scope here,
  // so this file is named to avoid the collision instead.
  testMatch: '**/*.e2e.ts',
  timeout: 30_000,
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  use: {
    baseURL: 'http://localhost:4173',
  },
  webServer: [
    {
      // Real backend + real Loreweaver MCP server (fake embeddings) + scripted model.
      command:
        'LW_MOCK_MODEL=tests/e2e/script.json HARNESS_CONFIG=tests/e2e/e2e.config.json npx tsx src/server/index.ts',
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
  ],
});
