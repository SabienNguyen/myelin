import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_AUDIO_WAV } from '../../playwright.config.js';

// The same directory the config files resolve `${E2E_DIR}` to (this file lives in tests/e2e), so
// the fixture vaults written here and the vaults the harness backends read stay in lockstep no
// matter where the repo is checked out. Playwright runs globalSetup after webServer processes have
// already started but before any test executes; Loreweaver's VaultStore re-globs pages/ on every
// call (no startup cache — see its vaultStore.ts loadPages()), so it's safe for these fixtures to
// be written after the harness/Loreweaver servers have booted.
const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const VAULT = join(E2E_DIR, '.tmp-vault');

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
// writes mkdir recursively (loreweaver's vaultStore.ts dir()).
const GAP_VAULT = join(E2E_DIR, '.tmp-vault-gap');
const LABEL_VAULT = join(E2E_DIR, '.tmp-vault-label');
const PRONOUNCE_VAULT = join(E2E_DIR, '.tmp-vault-pronounce');

/** A mono 16-bit PCM WAV of a steady tone — the fake microphone input for the pronounce spec.
 *  A steady pitch reads as the level tone (ngang) no matter where Chromium's loop starts it, so the
 *  grade is deterministic; a glide would depend on loop phase. Built here, not committed, so there
 *  is no binary in the repo. */
function writeSteadyToneWav(path: string, hz = 180, seconds = 2, sampleRate = 16000): void {
  const n = seconds * sampleRate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.5 * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}


export default async function globalSetup() {
  rmSync(VAULT, { recursive: true, force: true }); // idempotent across repeated `npm run e2e` runs
  mkdirSync(join(VAULT, 'pages'), { recursive: true });
  writeFileSync(
    join(VAULT, 'pages', 'derivatives.md'),
    '---\ntitle: Derivatives\ndifficulty: 1\nstatus: solid\n---\n' +
      'The derivative measures the instantaneous rate of change — the slope at a point.',
  );

  // label-diagram.e2e.ts's vault: fresh sessions each run, and the page its evidence lands on.
  rmSync(join(LABEL_VAULT, 'students'), { recursive: true, force: true });
  rmSync(join(LABEL_VAULT, '.harness', 'sessions'), { recursive: true, force: true });
  mkdirSync(join(LABEL_VAULT, 'pages'), { recursive: true });
  writeFileSync(
    join(LABEL_VAULT, 'pages', 'water-cycle.md'),
    '---\ntitle: The Water Cycle\ndifficulty: 1\nstatus: solid\n---\nEvaporation, condensation, precipitation.',
  );

  // pronounce.e2e.ts's vault + the fake microphone WAV it records. Same fresh-sessions reset as
  // the label vault, and the page its applied-correctly evidence lands on.
  rmSync(join(PRONOUNCE_VAULT, 'students'), { recursive: true, force: true });
  rmSync(join(PRONOUNCE_VAULT, '.harness', 'sessions'), { recursive: true, force: true });
  mkdirSync(join(PRONOUNCE_VAULT, 'pages'), { recursive: true });
  writeFileSync(
    join(PRONOUNCE_VAULT, 'pages', 'vietnamese-tones.md'),
    '---\ntitle: Vietnamese Tones\ndifficulty: 1\nstatus: solid\n---\nThe six tones: ngang, huyền, sắc, hỏi, ngã, nặng.',
  );
  writeSteadyToneWav(FAKE_AUDIO_WAV);

  rmSync(join(GAP_VAULT, 'students'), { recursive: true, force: true });
  // Also reset persisted chat threads: the SPA's default thread id is literally 'default'
  // (src/client/lib/urlState.ts), so a previous run's saved conversation — complete with its own
  // finished code_exercise card — would be loaded into the UI at page open and the test's
  // "exactly one graded block" assertions would see doubles (observed as a Playwright strict-mode
  // violation on .graded-tag). Sessions live under .harness/sessions (src/server/sessionStore.ts);
  // this read happens during the test (GET /api/thread/:id), safely after this wipe.
  rmSync(join(GAP_VAULT, '.harness', 'sessions'), { recursive: true, force: true });
  mkdirSync(join(GAP_VAULT, 'pages'), { recursive: true });

  // graph-contextual.e2e.ts's 1-hop/2-hop neighborhood around the boot-seeded 'stream-consumer'
  // stub. Written HERE, not in that file's beforeAll, because the backend's /api/graph payload is
  // TTL-cached (src/server/graphCache.ts): when the gap tests run first, their chat turns warm
  // the cache, and fixture pages written after that warm were invisible to the graph test's
  // fresh-by-TTL read. global-setup runs before any test can warm anything. Slugs come from the
  // file's BASENAME alone (loreweaver's loadPages()), the directory nesting is cosmetic.
  const fixtureDir = join(GAP_VAULT, 'pages', 'programming');
  mkdirSync(fixtureDir, { recursive: true });
  const GAP_FIXTURE_PAGES: Record<string, string> = {
    'decoder.md':
      '---\ntitle: Stream Decoding\nprereqs: [stream-consumer]\ndeepens: []\ndifficulty: 3\nstatus: stub\n---\n'
      + 'Fixture page for the contextual-graph e2e test (1 hop from stream-consumer).\n',
    'backpressure.md':
      '---\ntitle: Backpressure Handling\nprereqs: [stream-consumer]\ndeepens: []\ndifficulty: 3\nstatus: stub\n---\n'
      + 'Fixture page for the contextual-graph e2e test (1 hop from stream-consumer).\n',
    'reconnect-strategy.md':
      '---\ntitle: Reconnect Strategy\nprereqs: [decoder]\ndeepens: []\ndifficulty: 3\nstatus: stub\n---\n'
      + 'Fixture page for the contextual-graph e2e test (2 hops from stream-consumer, via decoder).\n',
    'unrelated-topic.md':
      '---\ntitle: Totally Unrelated Topic\nprereqs: []\ndeepens: []\ndifficulty: 1\nstatus: stub\n---\n'
      + 'Deliberately disconnected from stream-consumer — proves contextual scope excludes it.\n',
  };
  for (const [name, content] of Object.entries(GAP_FIXTURE_PAGES)) {
    writeFileSync(join(fixtureDir, name), content);
  }

  // Forked Playwright test workers inherit process.env from this (the main runner) process.
  process.env.E2E_VAULT = VAULT;
  process.env.E2E_GAP_VAULT = GAP_VAULT;
}
