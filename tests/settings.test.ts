// settings.json — what the models popover persists. Redirected to a temp dir via XDG_CONFIG_HOME
// (the same seam the credentials tests use); the four provider env vars are cleared per test and
// restored after, since applyEnvValues writes them into the real process.env.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODEL, loadConfig } from '../src/server/config.js';
import {
  applySettings, envShadow, PROVIDER_ENV_KEYS, readSettings, resetEnvShadow, settingsPath,
  writeSettings, type Settings,
} from '../src/server/settings.js';

let confDir: string;
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  confDir = mkdtempSync(join(tmpdir(), 'lwh-settings-'));
  vi.stubEnv('XDG_CONFIG_HOME', confDir);
  savedEnv = {};
  for (const k of PROVIDER_ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  resetEnvShadow();
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of PROVIDER_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetEnvShadow();
  rmSync(confDir, { recursive: true, force: true });
});

const bareConfig = (overrides: object = {}) => {
  // A minimal harness.config.json in the temp dir; engram is pinned so loadConfig does not probe
  // the filesystem ladder.
  const path = join(confDir, 'harness.config.json');
  writeFileSync(path, JSON.stringify({
    vault: join(confDir, 'vault'),
    engram: { command: 'node', args: ['/dev/null'] },
    ...overrides,
  }));
  return path;
};

describe('settings.json placement and shape', () => {
  it('lives beside credentials.json in the OS config dir', () => {
    expect(settingsPath()).toBe(join(confDir, 'myelin', 'settings.json'));
  });

  it('round-trips, is written 0600, and a corrupt file reads as empty', () => {
    const saved = {
      models: { grader: 'ollama:qwen' },
      contextTokens: { grader: 32_768 },
      env: { OLLAMA_API_KEY: 'k' },
    };
    writeSettings(saved);
    expect(readSettings()).toEqual(saved);
    expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
    writeFileSync(settingsPath(), '{not json');
    expect(readSettings()).toEqual({});
  });
});

describe('merge precedence: defaults < harness.config.json < settings.json', () => {
  it('a saved role beats the config file, which beats the default', () => {
    const cfgPath = bareConfig({
      models: { grader: { model: 'ollama:from-file' }, card_gen: { model: 'ollama:file-card' } },
    });
    writeSettings({ models: { grader: 'ollama:from-settings', tutor: 'ollama:saved-tutor' } });
    const cfg = loadConfig(cfgPath);
    applySettings(cfg);
    expect(cfg.models.grader.model).toBe('ollama:from-settings'); // saved beats file
    expect(cfg.models.tutor.model).toBe('ollama:saved-tutor');    // saved beats default
    expect(cfg.models.card_gen.model).toBe('ollama:file-card');   // file beats default
    expect(cfg.models.compile.model).toBe(DEFAULT_MODEL);         // default untouched
  });

  it('a saved context window beats the file; a hand-edited nonsense one is ignored OUT LOUD', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const cfgPath = bareConfig({ models: { compile: { model: 'ollama:x', contextTokens: 16_384 } } });
      writeSettings({ contextTokens: { compile: 32_768, grader: 0, tutor: '8192' as unknown as number } });
      const cfg = loadConfig(cfgPath);
      applySettings(cfg);
      expect(cfg.models.compile.contextTokens).toBe(32_768);
      // Everything downstream — budgetChars, historyBudgetTokens, the ledger's truncation warning
      // — reads 0 or a string as "no window declared", so these would look configured and do
      // nothing. The learner hears about it instead.
      expect(cfg.models.grader.contextTokens).toBeUndefined();
      expect(cfg.models.tutor.contextTokens).toBeUndefined();
      expect(err.mock.calls.map(String).join('\n')).toMatch(/contextTokens\.grader.*\n.*contextTokens\.tutor/s);
    } finally {
      err.mockRestore();
    }
  });

  it('a hand-edited claude-sdk: id in settings.json is skipped, not applied, and named', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeSettings({ models: { tutor: 'claude-sdk:opus' } });
      const cfg = loadConfig(bareConfig());
      applySettings(cfg);
      expect(cfg.models.tutor.model).toBe(DEFAULT_MODEL); // the boot value survives
      expect(String(err.mock.calls[0]?.[0])).toMatch(/claude-sdk:' has been removed/);
    } finally {
      err.mockRestore();
    }
  });
});

describe('a role saved as an OBJECT (hand-tuned sampler), not a bare id', () => {
  // The motivating real case: someone hand-edits quiz_gen in settings.json to
  // `{ model, sampler: { topP, topK, minP } }` to tame a local model, and this used to vanish —
  // applySettings skipped anything that was not `typeof === 'string'`, with nothing logged, so the
  // role silently ran on the default model forever.
  it('a valid object sets the model and every other field it declares', () => {
    writeSettings({
      models: {
        quiz_gen: {
          model: 'openai:bonsai-2-27b',
          effort: 'high',
          sampler: { topP: 0.95, topK: 20, minP: 0 },
          contextTokens: 16_384,
          concurrency: 2,
        },
      },
    });
    const cfg = loadConfig(bareConfig());
    applySettings(cfg);
    expect(cfg.models.quiz_gen.model).toBe('openai:bonsai-2-27b');
    expect(cfg.models.quiz_gen.effort).toBe('high');
    expect(cfg.models.quiz_gen.sampler).toEqual({ topP: 0.95, topK: 20, minP: 0 });
    expect(cfg.models.quiz_gen.contextTokens).toBe(16_384);
    expect(cfg.models.quiz_gen.concurrency).toBe(2);
  });

  it('an invalid object is refused OUT LOUD, naming the role and the file, and the role keeps its default', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // No `model` — the one field roleSchema actually requires.
      writeSettings({ models: { grader: { sampler: { topP: 0.95 } } } } as unknown as Settings);
      const cfg = loadConfig(bareConfig());
      applySettings(cfg);
      expect(cfg.models.grader.model).toBe(DEFAULT_MODEL); // the boot value survives
      expect(err).toHaveBeenCalledTimes(1);
      const msg = String(err.mock.calls[0]?.[0]);
      expect(msg).toContain(settingsPath());
      expect(msg).toContain('models.grader');
    } finally {
      err.mockRestore();
    }
  });

  it('claude-sdk: inside an object is refused exactly like a bare claude-sdk: id', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeSettings({ models: { tutor: { model: 'claude-sdk:opus', sampler: { topP: 0.9 } } } });
      const cfg = loadConfig(bareConfig());
      applySettings(cfg);
      expect(cfg.models.tutor.model).toBe(DEFAULT_MODEL);
      expect(String(err.mock.calls[0]?.[0])).toMatch(/claude-sdk:' has been removed/);
    } finally {
      err.mockRestore();
    }
  });

  it('garbage that is neither a string nor an object is refused the same way, not silently skipped', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeSettings({ models: { grader: 42 } } as unknown as Settings);
      const cfg = loadConfig(bareConfig());
      applySettings(cfg);
      expect(cfg.models.grader.model).toBe(DEFAULT_MODEL);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]?.[0])).toContain('models.grader');
    } finally {
      err.mockRestore();
    }
  });
});

describe('env group: a real environment variable wins over a saved value', () => {
  it('applies saved values only where the environment is silent', () => {
    process.env.OLLAMA_BASE_URL = 'http://real:9/v1'; // set before first capture = a real var
    writeSettings({
      env: { OLLAMA_BASE_URL: 'http://saved:1/v1', OPENAI_COMPAT_BASE_URL: 'https://saved.example/v1' },
    });
    const cfg = loadConfig(bareConfig());
    applySettings(cfg);
    expect(process.env.OLLAMA_BASE_URL).toBe('http://real:9/v1');           // real env kept winning
    expect(process.env.OPENAI_COMPAT_BASE_URL).toBe('https://saved.example/v1'); // unset -> applied
    expect(envShadow().OLLAMA_BASE_URL).toBe(true);
    expect(envShadow().OPENAI_COMPAT_BASE_URL).toBe(false);
  });
});
