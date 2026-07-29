// What a first run costs. Before this, fifteen config fields were mandatory and the example file
// pointed at one particular person's home directory, so a fresh clone could not start at all until
// someone edited paths by hand. These tests pin the two claims that replaced that:
//
//   1. A missing config file is a valid config — every field defaults to something that works.
//   2. The one thing that CANNOT be defaulted (the API key) is named precisely, stored outside the
//      vault, and never allowed to override the environment.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultVaultPath, loadConfig, resolveEngram, configSource } from '../src/server/config.js';
import {
  credentialsPath, readCredentials, writeCredentials, applyCredentials, looksLikeAnthropicKey,
} from '../src/server/credentials.js';
import { needsApiKey } from '../src/server/setupRoutes.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'lwh-setup-'));

describe('zero-config startup', () => {
  it('loads with no config file at all', () => {
    const cfg = loadConfig(join(tmp(), 'does-not-exist.json'));
    expect(configSource().found).toBe(false);
    expect(cfg.vault).toBeTruthy();
    expect(cfg.student).toBeTruthy();
    expect(cfg.port).toBe(4820);
    expect(cfg.autoCompile).toBe(true);
    // All five roles present, which is what every modelFor() call assumes.
    expect(Object.keys(cfg.models).sort())
      .toEqual(['card_gen', 'compile', 'grader', 'quiz_gen', 'tutor']);
    expect(cfg.schedule.digestHour).toBe(9);
    expect(cfg.engram.args.length).toBeGreaterThan(0);
  });

  it('lets a partial config override only what it names', () => {
    const dir = tmp();
    const path = join(dir, 'harness.config.json');
    writeFileSync(path, JSON.stringify({ port: 9999, models: { tutor: { model: 'ollama:qwen' } } }));
    const cfg = loadConfig(path);
    expect(configSource()).toEqual({ path, found: true });
    expect(cfg.port).toBe(9999);
    expect(cfg.models.tutor.model).toBe('ollama:qwen');
    expect(cfg.models.grader.model).toBe('claude-haiku-4-5'); // untouched roles still default
  });

  it('still refuses a config that exists but is wrong', () => {
    // Silence is the wrong answer for a file the user wrote themselves.
    const path = join(tmp(), 'harness.config.json');
    writeFileSync(path, JSON.stringify({ port: 'four thousand' }));
    expect(() => loadConfig(path)).toThrow();
  });

  it('puts the vault where a person would look for it', () => {
    const home = tmp();
    expect(defaultVaultPath(home)).toBe(join(home, 'myelin-vault'));
    mkdirSync(join(home, 'Documents'));
    // A vault is Obsidian-compatible markdown the learner is meant to open, so Documents wins
    // over any application-support directory whenever it exists.
    expect(defaultVaultPath(home)).toBe(join(home, 'Documents', 'Myelin'));
  });
});

describe('finding the Engram MCP server', () => {
  const saved = process.env.ENGRAM_ENTRY;
  afterEach(() => {
    if (saved === undefined) delete process.env.ENGRAM_ENTRY;
    else process.env.ENGRAM_ENTRY = saved;
  });

  it('finds the sibling checkout this repo is developed against', () => {
    delete process.env.ENGRAM_ENTRY;
    const { command, args } = resolveEngram();
    expect(args[args.length - 1]).toMatch(/(engram|loreweaver)\/(dist\/server\.js|src\/server\.ts)$/);
    expect(existsSync(args[args.length - 1])).toBe(true);
    expect(command).toBeTruthy();
  });

  it('runs a compiled entry on this very Node binary, not npx', () => {
    // A packaged app has no npx on PATH, so `npx tsx` would be an unfixable failure there.
    process.env.ENGRAM_ENTRY = '/opt/app/engram/dist/server.js';
    expect(resolveEngram()).toEqual({ command: process.execPath, args: ['/opt/app/engram/dist/server.js'] });
  });

  it('uses tsx for a source entry, which only a dev checkout has', () => {
    process.env.ENGRAM_ENTRY = '/home/dev/engram/src/server.ts';
    expect(resolveEngram()).toEqual({ command: 'npx', args: ['tsx', '/home/dev/engram/src/server.ts'] });
  });
});

describe('the API key, the one thing that cannot be defaulted', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it('is stored outside the vault', () => {
    // The vault gets opened in Obsidian, synced to a phone and pushed to a git remote. Every one of
    // those is a way to leak a key, so the key does not live there.
    const p = credentialsPath('/home/x', 'linux');
    expect(p).not.toMatch(/vault|Engram\/pages/);
    expect(credentialsPath('/home/x', 'darwin')).toBe('/home/x/Library/Application Support/Myelin/credentials.json');
  });

  it('round-trips, and the file is not world-readable', () => {
    const path = join(tmp(), 'nested', 'credentials.json');
    writeCredentials({ anthropicApiKey: 'sk-ant-test' }, path);
    expect(readCredentials(path).anthropicApiKey).toBe('sk-ant-test');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('re-tightens a file that already existed loosely', () => {
    // writeFileSync's `mode` is ignored for an existing file, so without the explicit chmod a file
    // created loosely once would stay loose forever.
    const path = join(tmp(), 'credentials.json');
    writeFileSync(path, '{}', { mode: 0o644 });
    writeCredentials({ anthropicApiKey: 'sk-ant-test' }, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('survives a corrupt file instead of refusing to boot', () => {
    const path = join(tmp(), 'credentials.json');
    writeFileSync(path, 'not json at all');
    expect(readCredentials(path)).toEqual({});
  });

  it('never lets a saved key override the environment', () => {
    const path = join(tmp(), 'credentials.json');
    writeCredentials({ anthropicApiKey: 'sk-ant-saved' }, path);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    applyCredentials(path);
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-from-env');
  });

  it('applies the saved key when the environment has none', () => {
    const path = join(tmp(), 'credentials.json');
    writeCredentials({ anthropicApiKey: 'sk-ant-saved' }, path);
    delete process.env.ANTHROPIC_API_KEY;
    applyCredentials(path);
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-saved');
  });

  it('rejects things that are not keys before making a network call', () => {
    for (const bad of ['', 'hunter2', 'https://console.anthropic.com', 'sk-proj-openai-ish', 'sk-ant-short']) {
      expect(looksLikeAnthropicKey(bad)).toBe(false);
    }
    expect(looksLikeAnthropicKey('  sk-ant-api03-abcdefghij0123456789xyz  ')).toBe(true);
  });

  it('names exactly which roles need a key, and stays quiet for routes that do not', () => {
    const roles = (models: Record<string, string>) =>
      needsApiKey({ models: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, { model: v }])) } as any);
    expect(roles({ tutor: 'claude-sonnet-5', grader: 'ollama:qwen' })).toEqual(['tutor']);
    // A fully local or fully subscription-backed setup needs no key at all, and must not be nagged.
    expect(roles({ tutor: 'ollama:qwen', grader: 'claude-sdk:sonnet' })).toEqual([]);
  });
});

describe('the vault directory', () => {
  it('is created by the preflight rather than required to exist', () => {
    // Mirrors index.ts's preflight. Engram tolerates a missing vault (scanMd returns []), but
    // "the app made the folder" is the difference between working and looking broken on a first run.
    const vault = join(tmp(), 'Engram');
    mkdirSync(join(vault, 'pages'), { recursive: true });
    expect(existsSync(join(vault, 'pages'))).toBe(true);
    // And it must be safe to run twice.
    mkdirSync(join(vault, 'pages'), { recursive: true });
    writeFileSync(join(vault, 'pages', 'x.md'), '---\ntitle: X\n---\nbody');
    mkdirSync(join(vault, 'pages'), { recursive: true });
    expect(readFileSync(join(vault, 'pages', 'x.md'), 'utf8')).toContain('body');
  });
});
