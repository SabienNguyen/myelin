import { chromium } from '@playwright/test';
const SP = process.env.SP!;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

// Both persona openers run CONCURRENTLY — two contexts, two vaults, two students.
const run = async (name: string, url: string, ask: string) => {
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  page.on('pageerror', (e) => console.log(`[${name}] PAGE ERR:`, e.message));
  await page.goto(url);
  await page.getByPlaceholder('Ask your tutor…').waitFor();
  await page.waitForTimeout(1500);
  const mode = await page.locator('select[aria-label="Tutor mode"]').inputValue();
  console.log(`[${name}] cold-start mode:`, mode);
  const savePut = page.waitForResponse((r) => r.url().includes('/api/thread/') && r.request().method() === 'PUT', { timeout: 480_000 });
  await page.getByPlaceholder('Ask your tutor…').fill(ask);
  await page.keyboard.press('Enter');
  await savePut;
  await page.waitForTimeout(1200);
  console.log(`[${name}] TAIL:`, (await page.locator('.thread').innerText()).replace(/\n/g, ' | ').slice(-500));
  await page.screenshot({ path: `${SP}/${name}-1.png`, fullPage: true });
  await page.close();
};

await Promise.all([
  run('viet', 'http://localhost:4575/',
    "Xin chào! I want to learn Vietnamese from absolute zero — I can't read the tones yet. Start me properly: the six tones, "
    + 'how the diacritics work, and a few first phrases. Be honest about what you can and cannot teach here (like pronunciation audio).'),
  run('brain', 'http://localhost:4576/',
    'I want to understand the brain from three angles at once: neuroscience (neurons, circuits), biology (what a neuron physically is), '
    + 'and AI (how real neurons compare to artificial ones). Build me a proper foundation.'),
]);
await browser.close();
