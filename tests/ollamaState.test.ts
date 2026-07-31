import { describe, expect, it } from 'vitest';
import {
  classifyConnectionError, currentPlatform, detectOllama, installHint, knownBinaryPaths,
} from '../src/server/ollamaState.js';
import { pullFailureMessage } from '../src/server/setupRoutes.js';

const ROOT = 'http://localhost:11434';
const up = (async () => new Response('{"models":[]}', { status: 200 })) as unknown as typeof fetch;
const down = (async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) as unknown as typeof fetch;

describe('detectOllama', () => {
  it('reports running when the daemon answers, without shelling out', async () => {
    let searched = false;
    const found = await detectOllama(ROOT, {
      fetchImpl: up,
      which: async () => { searched = true; return null; },
    });
    expect(found.state).toBe('running');
    // The common case must stay cheap: no `which`, no filesystem walk.
    expect(searched).toBe(false);
  });

  it('separates a stopped daemon from a missing install', async () => {
    const stopped = await detectOllama(ROOT, {
      fetchImpl: down, which: async () => '/usr/local/bin/ollama',
    });
    expect(stopped).toMatchObject({ state: 'stopped', binary: '/usr/local/bin/ollama' });

    const absent = await detectOllama(ROOT, {
      fetchImpl: down, which: async () => null, exists: () => false, platform: 'macos',
    });
    expect(absent.state).toBe('absent');
  });

  // The bug this guards: an Electron app launched from Finder often has a PATH without
  // /usr/local/bin, so `which` misses an Ollama that is plainly installed — and we would have told
  // the learner to go install the thing sitting in their Applications folder.
  it('finds an installed binary that is off this process PATH', async () => {
    const found = await detectOllama(ROOT, {
      fetchImpl: down,
      which: async () => null,
      platform: 'macos',
      home: '/Users/ada',
      exists: (p) => p === '/Applications/Ollama.app/Contents/Resources/ollama',
    });
    expect(found).toMatchObject({ state: 'stopped' });
  });

  it('carries a platform-correct install hint when absent', async () => {
    const linux = await detectOllama(ROOT, {
      fetchImpl: down, which: async () => null, exists: () => false, platform: 'linux',
    });
    expect(linux).toMatchObject({ state: 'absent', install: { platform: 'linux' } });
    if (linux.state !== 'absent') throw new Error('unreachable');
    expect(linux.install.command).toContain('ollama.com/install.sh');

    // macOS and Windows have no official one-liner, so we must not invent one.
    expect(installHint('macos').command).toBeUndefined();
    expect(installHint('windows').command).toBeUndefined();
    expect(installHint('macos').url).toContain('mac');
  });
});

describe('platform helpers', () => {
  it('maps node platforms to the three we have install paths for', () => {
    expect(currentPlatform('darwin')).toBe('macos');
    expect(currentPlatform('win32')).toBe('windows');
    expect(currentPlatform('freebsd')).toBe('linux');
  });

  it('looks in the places each installer actually writes to', () => {
    expect(knownBinaryPaths('macos', '/Users/ada')).toContain('/opt/homebrew/bin/ollama');
    expect(knownBinaryPaths('windows', 'C:\\Users\\ada'))
      .toContain('C:\\Users\\ada\\AppData\\Local\\Programs\\Ollama\\ollama.exe');
  });
});

describe('classifyConnectionError', () => {
  it('names the cause from the detected state, not the socket error', () => {
    const err = { cause: { code: 'ECONNREFUSED' } };
    expect(classifyConnectionError(err, { state: 'absent', root: ROOT, install: installHint('macos') }))
      .toBe('not-installed');
    expect(classifyConnectionError(err, { state: 'stopped', root: ROOT, binary: '/x/ollama' }))
      .toBe('not-running');
  });

  it('calls a refusal against a live daemon unreachable, not uninstalled', () => {
    const running = { state: 'running', root: ROOT } as const;
    expect(classifyConnectionError({ cause: { code: 'ETIMEDOUT' } }, running)).toBe('unreachable');
  });
});

describe('pullFailureMessage', () => {
  // The whole point of the change: three causes must not share one sentence. The old code told a
  // learner with Ollama running to go install it from ollama.com.
  it('says something different, and true, for each cause', () => {
    const install = pullFailureMessage('not-installed', 'qwen3:8b', ROOT);
    const start = pullFailureMessage('not-running', 'qwen3:8b', ROOT);
    const net = pullFailureMessage('unreachable', 'qwen3:8b', ROOT);
    expect(new Set([install, start, net]).size).toBe(3);

    expect(install).toMatch(/isn't installed/);
    expect(start).toMatch(/isn't running/);
    // Never send someone who already has Ollama off to download it again — the specific failure
    // that made this flow read as broken. Naming it as installed is fine; instructing an install
    // is not, so assert on the instruction rather than the word.
    expect(start).not.toMatch(/ollama\.com|\binstall it\b/i);
    expect(net).not.toMatch(/ollama\.com|\binstall it\b/i);
    expect(install).toMatch(/install it/i);
    expect(net).toContain(ROOT);
  });
});
