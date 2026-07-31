// Real tutor/student lesson on the PyTorch vault, Luna throughout. Scenario: a learner who wants
// to PRACTISE, not be lectured — the case that should reach code_exercise now that PyTorch
// exercises exist. Records what the learner sees, which instruments got staged, and timings.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const S = '/tmp/claude-1000/-home-sabien-Dev-personal-myelin/41aef935-49b2-44f8-9881-962caa5b97ed/scratchpad';
const out = [];
const errs = [];
const b = await chromium.launch({ headless: false, slowMo: 120 });
const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
p.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
p.on('console', (m) => m.type() === 'error' && errs.push(`[console] ${m.text()}`));

const settle = async (ms = 300_000) => {
  await p.waitForTimeout(1500);
  await p.getByText('tutor is working', { exact: false })
    .waitFor({ state: 'hidden', timeout: ms }).catch(() => out.push('  !! still working at deadline'));
  await p.waitForTimeout(1000);
};
const chat = async () => (await p.locator('.aui-thread-viewport, main').first().innerText()).slice(-1500);

async function say(label, text, mode) {
  const t0 = Date.now();
  if (mode) await p.locator('select').first().selectOption(mode);
  await p.getByRole('textbox', { name: 'Ask your tutor…' }).fill(text);
  await p.keyboard.press('Enter');
  await settle();
  const kinds = await p.locator('.block').evaluateAll((els) => els.map((e) => e.className));
  out.push(`\n===== ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s) =====\nYOU: ${text}`);
  out.push(`blocks on page: ${JSON.stringify(kinds)}`);
  out.push(`--- chat ---\n${await chat()}`);
}

await p.goto('http://localhost:4297/#/t/practice-lesson', { waitUntil: 'networkidle' });
await say('S1 wants practice', 'I do not want to be lectured. Give me something to actually DO about PyTorch autograd.', 'learn');
await say('S2 explicit', 'Can you give me a coding exercise from the pytorch repo itself?', 'freeform');
await say('S3 explain-back', 'Ask me to explain gradient accumulation in my own words and grade it.');

writeFileSync(`${S}/lesson.txt`, out.join('\n') + '\n\nERRORS:\n' + (errs.join('\n') || 'none'));
console.log(out.join('\n').slice(-2500));
console.log('\nERRORS:', errs.length || 'none');
await p.waitForTimeout(240_000);
await b.close();
