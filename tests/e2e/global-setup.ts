import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Same absolute path baked into tests/e2e/e2e.config.json's "vault" (~ expansion resolves to
// this). Playwright runs globalSetup after webServer processes have already started but before
// any test executes; Loreweaver's VaultStore re-globs pages/ on every call (no startup cache —
// see ~/Dev/personal/loreweaver/src/vault/vaultStore.ts loadPages()), so it's safe for this
// fixture to be written after the harness/Loreweaver servers have booted.
const VAULT = join(homedir(), 'Dev/personal/loreweaver-harness/tests/e2e/.tmp-vault');

export default async function globalSetup() {
  rmSync(VAULT, { recursive: true, force: true }); // idempotent across repeated `npm run e2e` runs
  mkdirSync(join(VAULT, 'pages'), { recursive: true });
  writeFileSync(
    join(VAULT, 'pages', 'derivatives.md'),
    '---\ntitle: Derivatives\ndifficulty: 1\nstatus: solid\n---\n' +
      'The derivative measures the instantaneous rate of change — the slope at a point.',
  );
  // Forked Playwright test workers inherit process.env from this (the main runner) process.
  process.env.E2E_VAULT = VAULT;
}
