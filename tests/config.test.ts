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
  it('fails loud on missing role', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-'));
    const p = join(dir, 'bad.json');
    const { grader: _drop, ...restModels } = valid.models;
    writeFileSync(p, JSON.stringify({ ...valid, models: restModels }));
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
