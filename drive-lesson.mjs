// Real tutor/student lesson on the PyTorch vault, Luna throughout.
// Scenario: a learner who wants to PRACTISE, not be lectured — the case that must reach
// writing_draft / code_exercise rather than another multiple-choice question.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const S = '/tmp/claude-1000/-home-sabien-Dev-personal-myelin/41aef935-49b2-44f8-9881-962caa5b97ed/scratchpad';
const THREAD = process.argv[2] ?? `lesson-${Date.now()}`;
const out = [];
const errs = [];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
p.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
p.on('console', (m) => m.type() === 'error' && errs.push(`[console] ${m.text().slice(0, 160)}`));

await p.goto(`http://localhost:4297/#/t/${THREAD}`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(8000);

const composer = () => p.getByRole('textbox', { name: 'Ask your tutor…' });
await composer().waitFor({ state: 'visible', timeout: 60_000 });

async function say(label, text, mode) {
  const t0 = Date.now();
  // Mode is driven by the slash commands the app already supports, not the select — the select
  // interaction proved flaky in this harness and /freeform is the same instruction to the server.
  if (mode && mode !== 'learn') {
    const m = composer();
    await m.click();
    await m.fill(`/${mode}`);
    await p.keyboard.press('Enter');
    await p.waitForTimeout(2500);
  }
  const box = composer();
  await box.waitFor({ state: 'visible', timeout: 60_000 });
  await box.click();
  await box.fill(text);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1500);
  await p.getByText('tutor is working', { exact: false })
    .waitFor({ state: 'hidden', timeout: 300_000 })
    .catch(() => out.push('  !! still working at deadline'));
  await p.waitForTimeout(1000);
  out.push(`\n===== ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s) =====\nYOU: ${text}`);
}

await say('S1 wants to DO', 'I do not want to be lectured. Give me something to actually DO about PyTorch autograd.', 'learn');
await say('S2 explicit code', 'Give me a coding exercise from the pytorch repo itself.', 'freeform');
await say('S3 explain-back', 'Ask me to explain gradient accumulation in my own words and grade what I write.');

writeFileSync(`${S}/lesson-${THREAD}.txt`, out.join('\n') + '\n\nERRORS:\n' + (errs.join('\n') || 'none'));
console.log(out.join('\n'));
console.log('\nERRORS:', errs.length || 'none');
await b.close();
