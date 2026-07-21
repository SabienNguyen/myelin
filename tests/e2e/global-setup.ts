import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Same absolute path baked into tests/e2e/e2e.config.json's "vault" (~ expansion resolves to
// this). Playwright runs globalSetup after webServer processes have already started but before
// any test executes; Loreweaver's VaultStore re-globs pages/ on every call (no startup cache —
// see ~/Dev/personal/loreweaver/src/vault/vaultStore.ts loadPages()), so it's safe for this
// fixture to be written after the harness/Loreweaver servers have booted.
const VAULT = join(homedir(), 'Dev/personal/loreweaver-harness/tests/e2e/.tmp-vault');

// I3's gap-exercise.e2e.ts fixture vault (tests/e2e/gap.config.json's "vault"). No page fixture
// is written here on purpose: the harness backend booting against this vault has cfg.gap set, so
// seedPatternPages (src/server/seedPatternPages.ts) writes the 'stream-consumer' stub itself at
// boot — the exact boot-seeding path I3 exists to exercise, so global-setup must not pre-write
// it. And because globalSetup runs AFTER the webServer processes have booted (see the VAULT
// comment above; re-verified the hard way — an rmSync of this whole directory here deleted the
// page the backend had just seeded, and turn 2's record_evidence 404'd with "page not found"),
// the per-run reset below is surgical: remove only students/ (so the evidence assertion can never
// pass on a stale file from a previous run) and leave the freshly-seeded pages/ alone. No
// pre-created skeleton is needed for a first run from a clean checkout either — Loreweaver's
// writes mkdir recursively (~/Dev/personal/loreweaver/src/vault/vaultStore.ts dir()).
const GAP_VAULT = join(homedir(), 'Dev/personal/loreweaver-harness/tests/e2e/.tmp-vault-gap');

// I3 (docs/superpowers/plans/2026-07-20-gap-integration.md): "prefer REAL sidecar ... if
// unavailable, skip with a clear message rather than mock". global-setup pings the real the-gap
// systemd sidecar once and leaves the verdict in an env var Playwright test workers inherit;
// gap-exercise.e2e.ts reads it and test.skip()s with an explicit reason instead of faking a
// response — a code exercise's whole point (I2) is that reference_answer stripping and grading are
// enforced by the REAL service, so this test must never run against a mock.
const GAP_SIDECAR_URL = 'http://localhost:4930/api/ladder';

async function isGapSidecarUp(): Promise<boolean> {
  try {
    const res = await fetch(GAP_SIDECAR_URL, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export default async function globalSetup() {
  rmSync(VAULT, { recursive: true, force: true }); // idempotent across repeated `npm run e2e` runs
  mkdirSync(join(VAULT, 'pages'), { recursive: true });
  writeFileSync(
    join(VAULT, 'pages', 'derivatives.md'),
    '---\ntitle: Derivatives\ndifficulty: 1\nstatus: solid\n---\n' +
      'The derivative measures the instantaneous rate of change — the slope at a point.',
  );

  rmSync(join(GAP_VAULT, 'students'), { recursive: true, force: true });
  // Also reset persisted chat threads: the SPA's default thread id is literally 'default'
  // (src/client/lib/urlState.ts), so a previous run's saved conversation — complete with its own
  // finished code_exercise card — would be loaded into the UI at page open and the test's
  // "exactly one graded block" assertions would see doubles (observed as a Playwright strict-mode
  // violation on .graded-tag). Sessions live under .harness/sessions (src/server/sessionStore.ts);
  // this read happens during the test (GET /api/thread/:id), safely after this wipe.
  rmSync(join(GAP_VAULT, '.harness', 'sessions'), { recursive: true, force: true });
  mkdirSync(join(GAP_VAULT, 'pages'), { recursive: true });

  // Forked Playwright test workers inherit process.env from this (the main runner) process.
  process.env.E2E_VAULT = VAULT;
  process.env.E2E_GAP_VAULT = GAP_VAULT;
  process.env.E2E_GAP_SIDECAR_UP = (await isGapSidecarUp()) ? '1' : '';
}
