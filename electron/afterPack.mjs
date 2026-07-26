// Copy the bundled Loreweaver into the packaged app's resources directory.
//
// This is an afterPack hook rather than an `extraResources` entry because electron-builder's copier
// STRIPS `node_modules` out of extra resources — and Loreweaver's shipped server imports
// @modelcontextprotocol/sdk and gray-matter at runtime, with nothing to hoist them. The result
// packaged cleanly, launched, and died on first contact with
// `ERR_MODULE_NOT_FOUND: Cannot find package '@modelcontextprotocol/sdk'`. A plain recursive copy
// after packing has no such opinion.
//
// It also has to live outside the asar archive, which resources/ is: Node cannot spawn a script from
// inside an archive, and the harness runs Loreweaver as a stdio child process.

import { cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default async function afterPack(context) {
  const from = join(root, 'vendor', 'loreweaver');
  if (!existsSync(from)) {
    throw new Error('vendor/loreweaver is missing — run `npm run bundle:loreweaver` first.\n'
      + 'Shipping without it would produce an app that starts and then cannot remember anything.');
  }
  const to = join(context.appOutDir, 'resources', 'loreweaver');
  cpSync(from, to, { recursive: true, dereference: true });

  // Fail the build rather than ship the exact bug this hook exists to prevent.
  const entry = join(to, 'dist', 'server.js');
  const deps = join(to, 'node_modules', '@modelcontextprotocol', 'sdk');
  for (const required of [entry, deps]) {
    if (!existsSync(required)) throw new Error(`bundled Loreweaver is incomplete: missing ${required}`);
  }
  console.log(`  • bundled Loreweaver  to=${to}`);
}
