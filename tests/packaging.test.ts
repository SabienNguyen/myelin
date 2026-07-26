// Packaging invariants. These are cheap static checks standing in for a build that takes minutes
// and 230MB — each one corresponds to something that actually broke while getting the desktop build
// working, and each failure mode was invisible until the packaged app was launched.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('desktop build configuration', () => {
  it('points Electron at the shell, not at a source file', () => {
    expect(pkg.main).toBe('electron/main.mjs');
    expect(existsSync(join(root, pkg.main))).toBe(true);
  });

  it('ships the built server and client, and nothing from src', () => {
    // `files` decides what lands in app.asar. Shipping src/ would be dead weight; NOT shipping
    // dist-server means the shell has nothing to import.
    expect(pkg.build.files).toContain('dist-server/**');
    expect(pkg.build.files).toContain('dist/**');
    expect(pkg.build.files.some((f: string) => f.startsWith('src'))).toBe(false);
  });

  it('copies Loreweaver in an afterPack hook rather than as an extraResource', () => {
    // Not a style preference. electron-builder STRIPS node_modules out of extraResources, and
    // Loreweaver's shipped server imports @modelcontextprotocol/sdk at runtime — so the
    // extraResources version packaged cleanly, launched, and died with ERR_MODULE_NOT_FOUND.
    expect(pkg.build.afterPack).toBe('electron/afterPack.mjs');
    expect(pkg.build.extraResources).toBeUndefined();
    expect(existsSync(join(root, 'electron/afterPack.mjs'))).toBe(true);
  });

  it('declares no publish provider', () => {
    // With one implied, electron-builder's update-info step tries to compute channel names from a
    // repository that is not configured and throws AFTER writing the artifact — a build that both
    // succeeded and failed.
    expect(pkg.build.publish).toBeNull();
  });

  it('unpacks the prompt markdown from the asar', () => {
    // prompt.ts and ingest.ts read their prompts with readFileSync at runtime. Inside an asar that
    // works via Electron's patched fs, but the server also runs on plain Node (npm start), so
    // keeping them unpacked keeps one code path for both.
    expect(pkg.build.asarUnpack).toContain('**/*.md');
  });

  it('has a build:all that produces both halves the shell needs', () => {
    expect(pkg.scripts['build:all']).toMatch(/build/);
    expect(pkg.scripts['build:server']).toMatch(/tsconfig\.server\.json/);
    // The asset copy is load-bearing: tsc emits .js only, so without it a compiled server throws
    // ENOENT on the tutor system prompt the first time anyone asks a question.
    expect(pkg.scripts['build:server']).toMatch(/copy-server-assets/);
  });

  it('assembles the two repos before packaging', () => {
    expect(pkg.scripts.dist).toMatch(/bundle:loreweaver/);
    expect(pkg.scripts.dist).toMatch(/build:all/);
  });
});

describe('the server build', () => {
  it('excludes the client and tests, which have their own toolchains', () => {
    const tsconfig = readFileSync(join(root, 'tsconfig.server.json'), 'utf8');
    // Comments are allowed in this file, so parse loosely rather than with JSON.parse.
    expect(tsconfig).toMatch(/"include":\s*\["src\/server",\s*"src\/shared"\]/);
    expect(tsconfig).toMatch(/"outDir":\s*"dist-server"/);
  });
});

describe('spawning Loreweaver from inside Electron', () => {
  it('sets ELECTRON_RUN_AS_NODE on the child', () => {
    // config.ts's runnerFor uses process.execPath to run a compiled entry, and inside the packaged
    // app that IS the Electron binary — launching it plainly opens a second app window instead of a
    // Node process. Verified against the packaged AppImage: the boot log shows Electron's own binary
    // as the Loreweaver runner, and /api/graph completes a real MCP round-trip through it.
    const mcp = readFileSync(join(root, 'src/server/mcp.ts'), 'utf8');
    expect(mcp).toMatch(/ELECTRON_RUN_AS_NODE:\s*'1'/);
  });
});
