import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/server/config.js';

const valid = {
  vault: '/tmp/vault', student: 'sabien',
  models: {
    tutor: { model: 'claude-sonnet-5' }, grader: { model: 'claude-haiku-4-5' },
    quiz_gen: { model: 'claude-sonnet-5' }, card_gen: { model: 'claude-haiku-4-5' },
    compile: { model: 'claude-sonnet-5' },
  },
  loreweaver: { command: 'npx', args: ['tsx', 'server.ts'], embeddings: 'fake' },
  schedule: { digestHour: 9, quietHours: [22, 8], ankiSyncMinutes: 30, ankiBacklogNudgeDays: 3 },
  port: 4820,
};

describe('loadConfig', () => {
  it('loads a valid config and expands ~', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-'));
    const p = join(dir, 'harness.config.json');
    writeFileSync(p, JSON.stringify({ ...valid, vault: '~/somewhere' }));
    const cfg = loadConfig(p);
    expect(cfg.vault.startsWith('/')).toBe(true);
    expect(cfg.vault.includes('~')).toBe(false);
    expect(cfg.models.tutor.model).toBe('claude-sonnet-5');
    expect(cfg.autoCompile).toBe(true); // defaults on when unset
  });
  it('expands a ${VAR} in the vault path from the environment', () => {
    // The portable-fixtures mechanism the e2e configs use: a path computed at launch and handed in
    // by env, so nothing bakes one machine's absolute layout into the committed file.
    const dir = mkdtempSync(join(tmpdir(), 'lwh-'));
    const p = join(dir, 'harness.config.json');
    writeFileSync(p, JSON.stringify({ ...valid, vault: '${E2E_DIR}/.tmp-vault' }));
    process.env.E2E_DIR = '/somewhere/e2e';
    try {
      expect(loadConfig(p).vault).toBe('/somewhere/e2e/.tmp-vault');
    } finally {
      delete process.env.E2E_DIR;
    }
  });
  it('expands a ${VAR} inside a loreweaver arg too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-'));
    const p = join(dir, 'harness.config.json');
    writeFileSync(p, JSON.stringify({
      ...valid,
      loreweaver: { command: 'npx', args: ['tsx', '${LOREWEAVER_SRC}'], embeddings: 'fake' },
    }));
    process.env.LOREWEAVER_SRC = '/checkout/loreweaver/src/server.ts';
    try {
      expect(loadConfig(p).loreweaver.args).toEqual(['tsx', '/checkout/loreweaver/src/server.ts']);
    } finally {
      delete process.env.LOREWEAVER_SRC;
    }
  });
  it('fills in a role the file leaves out', () => {
    // This test used to assert the opposite — that an omitted role was a boot error. That was the
    // right rule when config was mandatory and every field had to be stated; it is the wrong rule
    // now that the whole file is optional, because "omitted" and "absent file" have to mean the
    // same thing or a partial config becomes a trap.
    const dir = mkdtempSync(join(tmpdir(), 'lwh-'));
    const p = join(dir, 'partial.json');
    const { grader: _drop, ...restModels } = valid.models;
    writeFileSync(p, JSON.stringify({ ...valid, models: restModels }));
    expect(loadConfig(p).models.grader.model).toBe('claude-haiku-4-5');
  });

  it('still fails loud on a role that is present and wrong', () => {
    // Defaulting an ABSENT field is help; guessing what a MALFORMED one meant is not. A file the
    // user wrote themselves has to tell them when it is broken.
    const dir = mkdtempSync(join(tmpdir(), 'lwh-'));
    const p = join(dir, 'bad.json');
    writeFileSync(p, JSON.stringify({
      ...valid, models: { ...valid.models, grader: { model: 42 } },
    }));
    expect(() => loadConfig(p)).toThrow(/grader/);
  });
  it('honors an explicit autoCompile: false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-'));
    const p = join(dir, 'harness.config.json');
    writeFileSync(p, JSON.stringify({ ...valid, autoCompile: false }));
    expect(loadConfig(p).autoCompile).toBe(false);
  });
  it('gap sidecar config is optional; absent by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-'));
    const p = join(dir, 'harness.config.json');
    writeFileSync(p, JSON.stringify(valid));
    expect(loadConfig(p).gap).toBeUndefined();
  });
  it('accepts a gap.url when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-'));
    const p = join(dir, 'harness.config.json');
    writeFileSync(p, JSON.stringify({ ...valid, gap: { url: 'http://localhost:4930' } }));
    expect(loadConfig(p).gap).toEqual({ url: 'http://localhost:4930' });
  });
});
