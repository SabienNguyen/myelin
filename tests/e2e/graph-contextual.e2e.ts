import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// This file's dedicated backend+frontend pair (playwright.config.ts) serves on :4174/:4821 — same
// pair gap-exercise.e2e.ts uses, and for the same reason: it's the pair safe to point arbitrary
// navigation at without disturbing whatever's actually live on :4173 (see playwright.config.ts's
// own comment on the two webServer pairs).
test.use({ baseURL: 'http://localhost:4174' });

const GAP_VAULT = join(homedir(), 'Dev/personal/loreweaver-harness/tests/e2e/.tmp-vault-gap');
const FIXTURE_DIR = join(GAP_VAULT, 'pages', 'programming');

// Extra pages linked off the boot-seeded 'stream-consumer' stub (seedPatternPages.ts writes it
// whenever cfg.gap is set — gap.config.json's backend always has it). Written directly to the
// vault's files rather than through Loreweaver's write_page tool, same as global-setup.ts's own
// VAULT fixture (see its comment: VaultStore re-globs pages/ on every call, no startup cache, so
// writing after the servers have already booted is safe). Slugs come from the file's BASENAME
// alone (loreweaver's vaultStore.ts loadPages()), not its directory, so nesting these under
// pages/programming/ is purely cosmetic. Gives the contextual-graph screenshot below a real
// 1-hop/2-hop neighborhood to render instead of just a lone seeded node.
const FIXTURE_PAGES: Record<string, string> = {
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
    + "Deliberately disconnected from stream-consumer — proves contextual scope excludes it.\n",
};

test.describe('Graph tab — contextual scope', () => {
  test.beforeAll(() => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    for (const [name, content] of Object.entries(FIXTURE_PAGES)) {
      writeFileSync(join(FIXTURE_DIR, name), content);
    }
  });
  test.afterAll(() => {
    for (const name of Object.keys(FIXTURE_PAGES)) rmSync(join(FIXTURE_DIR, name), { force: true });
  });

  test('defaults to a contextual subgraph around the open page, with a subtitle and a scope toggle', async ({ page }) => {
    // Deep-link straight into the Page tab already showing 'stream-consumer' — GraphPanel seeds
    // its context from the URL hash at mount (see GraphPanel.tsx's contextSeed useState
    // initializer), so switching to Graph afterward should show it already scoped, with no chat
    // turn or click needed to establish the "open page" signal.
    await page.goto('/#/t/e2e-graph-ctx/page/stream-consumer');
    // Scoped to PagePanel's own <h2> title: stream-consumer.md's body ALSO opens with a markdown
    // `# Consuming SSE token streams` heading, which renders as an <h1> with the same text — an
    // unscoped role query would resolve ambiguously between the two.
    await expect(page.locator('.page-panel h2')).toHaveText('Consuming SSE token streams');

    await page.getByRole('tab', { name: 'graph' }).click();

    await expect(page.getByRole('tab', { name: 'This topic' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Whole vault' })).toBeVisible();
    await expect(page.locator('.graph-subtitle')).toHaveText(/around Consuming SSE token streams · 2 hops/i);

    // 1-hop and 2-hop neighbors render (exact: true — each node also carries an SVG <title>
    // tooltip like "Stream Decoding — unseen", which getByText's default substring match would
    // otherwise also resolve, ambiguously, alongside the visible <text> label).
    await expect(page.getByText('Stream Decoding', { exact: true })).toBeVisible();
    await expect(page.getByText('Backpressure Handling', { exact: true })).toBeVisible();
    await expect(page.getByText('Reconnect Strategy', { exact: true })).toBeVisible();
    // ...but the deliberately-disconnected page does not — proof the view is actually scoped, not
    // just the full graph relabeled.
    await expect(page.getByText('Totally Unrelated Topic', { exact: true })).toHaveCount(0);

    await page.screenshot({
      path: '/tmp/claude-1000/-home-sabien-Dev-personal/a2271c77-9198-4cbf-ad90-dfbaa799d9d9/scratchpad/graph-contextual.png',
      fullPage: true,
    });

    // Whole vault escape hatch: toggling reveals the previously-hidden disconnected page and
    // drops the subtitle.
    await page.getByRole('tab', { name: 'Whole vault' }).click();
    await expect(page.getByText('Totally Unrelated Topic', { exact: true })).toBeVisible();
    await expect(page.locator('.graph-subtitle')).toHaveCount(0);
  });
});
