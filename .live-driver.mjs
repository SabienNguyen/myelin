// Throwaway live driver for the experiment session. Deleted when the run ends.
import { chromium } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const DIR = '/tmp/claude-1000/-home-sabien-Dev-personal-myelin/4e2244b6-6fd5-4304-a6be-9c5ced9ec124/scratchpad';
const CMD = `${DIR}/cmd.json`, OUT = `${DIR}/out.json`, LOG = `${DIR}/driver.log`;
const log = (s) => writeFileSync(LOG, `${new Date().toISOString()} ${s}\n`, { flag: 'a' });

const b = await chromium.launch({ headless: false, args: ['--window-size=1500,1000'] });
const p = await b.newPage({ viewport: { width: 1480, height: 940 } });
const errors = [];
p.on('console', (m) => m.type() === 'error' && errors.push(`[console.error] ${m.text().slice(0, 300)}`));
p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message.slice(0, 300)}`));
await p.goto('http://127.0.0.1:4820/', { waitUntil: 'networkidle' });
log('ready');

const transcript = async () => {
  const main = p.locator('main').first();
  return (await main.count()) ? (await main.innerText()).trim() : (await p.locator('body').innerText()).trim();
};
const settle = async (maxMs = 240_000) => {
  const t0 = Date.now(); let last = await transcript(); let stableSince = Date.now();
  while (Date.now() - t0 < maxMs) {
    await p.waitForTimeout(1000);
    const cur = await transcript();
    if (cur !== last) { last = cur; stableSince = Date.now(); }
    else if (Date.now() - stableSince > 4000) break;
  }
  return Date.now() - t0;
};
const dump = async () => ({
  url: p.url(),
  buttons: await p.getByRole('button').allInnerTexts().then((a) => a.map((s) => s.trim()).filter(Boolean).slice(0, 60)),
  textboxes: await p.getByRole('textbox').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.tagName)),
  transcript: (await transcript()).slice(-4000),
  errors: errors.splice(0),
});

while (true) {
  if (!existsSync(CMD)) { await p.waitForTimeout(500); continue; }
  let cmd; try { cmd = JSON.parse(readFileSync(CMD, 'utf8')); } catch { await p.waitForTimeout(300); continue; }
  unlinkSync(CMD);
  const res = { op: cmd.op, ok: true };
  try {
    if (cmd.op === 'say') {
      const box = p.getByRole('textbox', { name: 'Ask your tutor…' });
      await box.fill(cmd.text);
      const resp = p.waitForResponse((r) => r.url().endsWith('/api/chat'), { timeout: 60_000 });
      await p.keyboard.press('Enter');
      const r = await resp; res.status = r.status();
      res.settledMs = await settle();
      Object.assign(res, await dump());
    } else if (cmd.op === 'click') {
      const target = cmd.role
        ? p.getByRole(cmd.role, { name: cmd.name, exact: cmd.exact ?? false }).first()
        : p.getByText(cmd.name, { exact: cmd.exact ?? false }).first();
      await target.click({ timeout: 15_000 });
      if (cmd.waitChat) { await p.waitForResponse((r) => r.url().endsWith('/api/chat'), { timeout: 60_000 }); }
      res.settledMs = await settle(cmd.waitChat ? 240_000 : 8_000);
      Object.assign(res, await dump());
    } else if (cmd.op === 'fill') {
      await p.getByRole('textbox', { name: cmd.name }).first().fill(cmd.text);
      Object.assign(res, await dump());
    } else if (cmd.op === 'shot') {
      await p.screenshot({ path: cmd.path, fullPage: cmd.full ?? false });
      res.path = cmd.path;
    } else if (cmd.op === 'dump') {
      Object.assign(res, await dump());
    } else if (cmd.op === 'goto') {
      await p.goto(cmd.url, { waitUntil: 'networkidle' }); Object.assign(res, await dump());
    } else if (cmd.op === 'eval') {
      res.value = await p.evaluate(cmd.js);
    } else if (cmd.op === 'quit') {
      writeFileSync(OUT, JSON.stringify(res)); await b.close(); process.exit(0);
    }
  } catch (e) { res.ok = false; res.error = String(e?.message ?? e).slice(0, 600); Object.assign(res, await dump().catch(() => ({}))); }
  writeFileSync(OUT, JSON.stringify(res, null, 1));
  log(`${cmd.op} ${res.ok ? 'ok' : 'ERR ' + res.error}`);
}
