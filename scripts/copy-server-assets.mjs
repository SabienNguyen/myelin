#!/usr/bin/env node
// tsc emits .js and nothing else, but two of the server's runtime inputs are markdown files that
// live beside the source: the tutor system prompt and the compile prompt, both read with
// `readFileSync(join(here, '...md'))`. Without this, a compiled server starts and then throws ENOENT
// the first time anyone asks it a question — a failure that only shows up in the packaged app.

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src');
const to = join(root, 'dist-server');

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.md')) continue;
    const dest = join(to, relative(from, full));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(full, dest);
    console.log(`asset: ${relative(root, dest)}`);
  }
}

for (const sub of ['server', 'shared']) {
  const dir = join(from, sub);
  if (existsSync(dir)) walk(dir);
}
