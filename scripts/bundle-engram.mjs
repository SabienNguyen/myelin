#!/usr/bin/env node
// Assemble the two repos into one shippable tree.
//
// Engram is a separate repo on purpose — it is the memory layer, it has its own tests, and the
// harness talks to it only over stdio MCP. But a person downloading a tutor should not have to know
// that, let alone clone two things. So the desktop build copies a BUILT Engram into
// `vendor/engram/`, which the app then ships as an unpacked resource.
//
// Deliberately a copy rather than an npm `file:` dependency: a `file:../engram` entry in
// package.json would make `npm i` fail outright for anyone who cloned only the harness, which is
// the common case for working on it.
//
// Usage:  node scripts/bundle-engram.mjs [path-to-engram]
//         ENGRAM_REPO=/path/to/engram node scripts/bundle-engram.mjs

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const harness = resolve(here, '..');

function findRepo() {
  const given = process.argv[2] ?? process.env.ENGRAM_REPO;
  if (given) return resolve(given);
  // Same sibling-checkout assumption src/server/config.ts's resolveEngram makes, so a working
  // dev tree needs no arguments.
  for (const candidate of [resolve(harness, '../engram'), resolve(harness, '../../engram')]) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

const repo = findRepo();
if (!repo) {
  console.error('Cannot find the engram repo. Clone it beside this one, or pass its path:\n'
    + '  node scripts/bundle-engram.mjs ../engram');
  process.exit(1);
}
console.log(`engram: ${repo}`);

// `shell` on Windows: npm is `npm.cmd` there, and execFileSync won't find a `.cmd` without a shell
// (fails with `spawnSync npm ENOENT`). POSIX resolves the bare `npm` fine, so only Windows needs it.
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

// Its own deps first — the copy below includes node_modules, because the shipped server imports
// @modelcontextprotocol/sdk and gray-matter at runtime and nothing hoists them for it.
// npm ci, not npm install: install is allowed to REWRITE the checkout's package-lock.json (npm
// versions disagree about optional-dep metadata like `libc`), and a packaging script must never
// dirty the sibling repo it reads from. ci installs exactly the lockfile and writes nothing.
if (!existsSync(join(repo, 'node_modules'))) run('npm', ['ci'], repo);
run('npm', ['run', 'build'], repo);

const entry = join(repo, 'dist', 'server.js');
if (!existsSync(entry)) {
  console.error(`Build produced no ${entry} — check engram's own build.`);
  process.exit(1);
}

const out = join(harness, 'vendor', 'engram');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const part of ['dist', 'package.json', 'package-lock.json']) {
  const src = join(repo, part);
  if (existsSync(src)) cpSync(src, join(out, part), { recursive: true, dereference: true });
}

// Install RUNTIME deps only, from the lockfile, into the copy. Copying the dev checkout's
// node_modules and pruning afterwards was tried first and left 27MB of typescript/vitest/rollup
// behind — `prune` reasons about the tree it is given, and a copied tree without its own install
// history is not one it can reduce cleanly. `npm ci --omit=dev` builds the right tree from scratch:
// three packages, no dev tooling.
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], out);

const shipped = join(out, 'node_modules', '@modelcontextprotocol', 'sdk');
if (!existsSync(shipped)) {
  console.error(`Install produced no ${shipped} — the shipped server would fail to import its deps.`);
  process.exit(1);
}
console.log(`bundled -> ${out}`);
