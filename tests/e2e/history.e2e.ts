import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Same navigation-safe backend+frontend pair graph-contextual.e2e.ts uses (:4174/:4821 — see
// playwright.config.ts's webServer comment). This file sends NO /api/chat requests on purpose:
// the scripted model's turn counter is a per-process running count (the reason the gap pair
// exists at all), and a history drive needs none of it — threads are seeded straight into the
// vault's session store, exactly the files the server's own persistence writes.
test.use({ baseURL: 'http://localhost:4174' });

const SESSIONS = join(
  homedir(), 'Dev/personal/loreweaver-harness/tests/e2e/.tmp-vault-gap', '.harness', 'sessions',
);

const msg = (id: string, role: 'user' | 'assistant', text: string) =>
  ({ id, role, parts: [{ type: 'text', text }] });

test.beforeAll(() => {
  // global-setup wipes .harness/sessions before any test runs; these land after that wipe. The
  // shape mirrors what Runtime's onFinish PUTs — loadThread only needs an array of id'd messages.
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(join(SESSIONS, 'hist-a.json'), JSON.stringify([
    msg('a1', 'user', 'what is a derivative anyway?'),
    msg('a2', 'assistant', 'HISTORY-A: instantaneous rate of change.'),
  ]));
  writeFileSync(join(SESSIONS, 'hist-b.json'), JSON.stringify([
    msg('b1', 'user', 'what is an integral anyway?'),
    msg('b2', 'assistant', 'HISTORY-B: accumulated area under a curve.'),
  ]));
});

test.describe('Conversation history', () => {
  test('restores a deep-linked thread, lists conversations, and switches between them', async ({ page }) => {
    await page.goto('/#/t/hist-a');
    // .last(): the focus rail mirrors the latest assistant line, so the text appears twice.
    await expect(page.getByText('HISTORY-A: instantaneous rate of change.').last()).toBeVisible();

    await page.getByRole('button', { name: 'Conversation history' }).click();
    const menu = page.locator('.history-panel');
    // Rows are titled by the first substantive user message. Other specs' threads may also be
    // listed (shared vault) — assert ours are present, not that the list is exactly ours.
    await expect(menu.getByRole('menuitem', { name: /what is a derivative anyway/ })).toBeVisible();
    await menu.getByRole('menuitem', { name: /what is an integral anyway/ }).click();

    // Full transcript swap: B's text in, A's gone (both copies — chat and focus rail).
    await expect(page.getByText('HISTORY-B: accumulated area under a curve.').last()).toBeVisible();
    await expect(page.getByText('HISTORY-A: instantaneous rate of change.')).toHaveCount(0);
    // The switch is deep-linked: reloading this URL would land back in thread B.
    expect(new URL(page.url()).hash).toContain('/t/hist-b');
  });

  test('menu holds APG menu-button keyboard behavior', async ({ page }) => {
    await page.goto('/#/t/hist-a');
    await expect(page.getByText('HISTORY-A: instantaneous rate of change.').last()).toBeVisible();

    const trigger = page.getByRole('button', { name: 'Conversation history' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    // Focus moves into the menu on open (first menuitem), arrows walk it, Escape returns it.
    await expect(page.getByRole('menuitem', { name: 'New conversation' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[role="menuitem"]:focus')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(page.locator('.history-panel')).toHaveCount(0);
  });
});
