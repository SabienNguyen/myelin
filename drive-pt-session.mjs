// A real multi-turn learning session on the compiled PyTorch vault, driven through the actual UI
// with Luna as every role. Captures what the learner SEES each turn, plus tool activity and any
// failure text, so teaching quality can be judged from the artifact rather than from vibes.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const S = '/tmp/claude-1000/-home-sabien-Dev-personal-myelin/41aef935-49b2-44f8-9881-962caa5b97ed/scratchpad';
const log = [];
const errs = [];
// Headed + slowMo so it is watchable in real time.
const b = await chromium.launch({ headless: false, slowMo: 250, args: ['--start-maximized'] });
const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
p.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
p.on('console', (m) => m.type() === 'error' && errs.push(`[console] ${m.text()}`));

const settle = async (ms = 300_000) => {
  await p.waitForTimeout(2000);
  await p.getByText('tutor is working', { exact: false })
    .waitFor({ state: 'hidden', timeout: ms }).catch(() => log.push('!! still working at deadline'));
  await p.waitForTimeout(1200);
};

async function turn(label, text, opts = {}) {
  const t0 = Date.now();
  if (opts.mode) await p.locator('select').first().selectOption(opts.mode);
  await p.getByRole('textbox', { name: 'Ask your tutor…' }).fill(text);
  await p.keyboard.press('Enter');
  await settle();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const main = await p.locator('main').innerText();
  const blocks = await p.locator('.block').count();
  const open = await p.locator('.block.quick-check:not(.done)').count();
  log.push(`\n===== ${label} (${secs}s) =====\nYOU: ${text}\nblocks=${blocks} open=${open}\n--- transcript tail ---\n${main.slice(-2200)}`);
  return { open, secs };
}

async function answerOpen() {
  const blk = p.locator('.block.quick-check:not(.done)').first();
  if (!(await blk.count())) return false;
  const choices = blk.locator('> button');
  const n = await choices.count();
  const before = await p.locator('.verdict').count();
  if (n > 0) {
    const labels = await choices.allTextContents();
    log.push(`  [answering choice] options=${JSON.stringify(labels)} -> picking "${labels[0]}"`);
    await choices.first().click();
  } else {
    const inp = blk.locator('input[name="a"]');
    if (!(await inp.count())) return false;
    await inp.fill('a tensor operation'); await inp.press('Enter');
  }
  await p.waitForFunction((prev) => document.querySelectorAll('.verdict').length > prev, before, { timeout: 300_000 })
    .catch(() => log.push('  !! grading never arrived'));
  await settle();
  log.push(`  [after grading]\n${(await p.locator('main').innerText()).slice(-1200)}`);
  return true;
}

await p.goto('http://localhost:4297/#/t/pt-session', { waitUntil: 'networkidle' }).catch(() => {});
await p.goto('http://localhost:4297/', { waitUntil: 'networkidle' }).catch(() => {});

await turn('T1 cold open', 'I want to learn PyTorch. Where should I start?', { mode: 'learn' });
await turn('T2 concrete ask', 'Teach me what autograd actually does when I call backward().');
await answerOpen();
await turn('T3 follow-up', 'why does it need a graph at all?');
await answerOpen();
await turn('T4 next', 'whats next');
await answerOpen();
await turn('T5 freeform depth', 'Explain the difference between a Tensor and a Parameter, with an example.', { mode: 'freeform' });

writeFileSync(`${S}/pt-session.txt`, log.join('\n') + '\n\nPAGE ERRORS:\n' + (errs.join('\n') || 'none'));
console.log(log.join('\n').slice(0, 1500));
console.log('\n[full transcript written to pt-session.txt]');
console.log('PAGE ERRORS:', errs.length || 'none');
// Leave the window open so the session can be inspected after the drive finishes.
console.log('[leaving the browser open for 5 minutes — close it yourself, or Ctrl-C]');
await p.waitForTimeout(300_000);
await b.close();
