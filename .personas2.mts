import { chromium } from '@playwright/test';
const SP = process.env.SP!;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

const viet = async () => {
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  page.on('pageerror', (e) => console.log('[viet] ERR', e.message));
  await page.goto('http://localhost:4575/#/t/default');
  await page.waitForTimeout(2500);
  // Complete the tone-matching structured_check (it's a matching block).
  const block = page.locator('.block:not(.done)').last();
  const chips = await block.locator('.label-chip, button').allInnerTexts().catch(() => []);
  console.log('[viet] block controls:', (await block.getAttribute('class')));
  // Just push the capability question directly — that's the user's real ask.
  const savePut = page.waitForResponse((r) => r.url().includes('/api/thread/') && r.request().method() === 'PUT', { timeout: 480_000 });
  await page.getByPlaceholder('Ask your tutor…').fill(
    "Honest question before I go further: can this app actually help me HEAR the tones and check my pronunciation? "
    + 'Audio playback of each tone, or recording me and grading my accent? If not, tell me straight what is missing.');
  await page.keyboard.press('Enter');
  await savePut;
  await page.waitForTimeout(1200);
  console.log('[viet] CAPABILITY ANSWER:', (await page.locator('.thread').innerText()).replace(/\n/g, ' | ').slice(-900));
  await page.screenshot({ path: `${SP}/viet-2.png`, fullPage: true });
  await page.close();
};

const brain = async () => {
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  page.on('pageerror', (e) => console.log('[brain] ERR', e.message));
  await page.goto('http://localhost:4576/#/t/default');
  await page.waitForTimeout(2500);
  const block = page.locator('.block:not(.done)').last();
  const input = block.locator('input').first();
  await input.waitFor({ timeout: 8000 });
  const savePut = page.waitForResponse((r) => r.url().includes('/api/thread/') && r.request().method() === 'PUT', { timeout: 480_000 });
  await input.fill('No — they do not touch. There is a synaptic cleft, a tiny gap; the signal crosses chemically as neurotransmitters released from the presynaptic terminal bind receptors on the postsynaptic membrane (with some electrical gap-junction exceptions).');
  await block.getByRole('button', { name: /Answer|Submit/ }).click();
  await savePut;
  await page.waitForTimeout(1200);
  console.log('[brain] AFTER PROBE:', (await page.locator('.thread').innerText()).replace(/\n/g, ' | ').slice(-500));
  await page.screenshot({ path: `${SP}/brain-2.png`, fullPage: true });
  await page.close();
};

await Promise.all([viet(), brain()]);
await browser.close();
