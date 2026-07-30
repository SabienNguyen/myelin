import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearStance, readStance, readStances, setStance, STANCE_INSTRUCTIONS } from '../src/server/stanceStore.js';
import { STANCE_COMMANDS } from '../src/shared/commands.js';

const freshVault = () => mkdtempSync(join(tmpdir(), 'lwh-stance-'));

describe('stanceStore', () => {
  it('round-trips a stance per thread and merges instead of replacing', () => {
    const vault = freshVault();
    expect(readStance(vault, 't1')).toBeNull(); // no file yet
    setStance(vault, 't1', 'beginner');
    setStance(vault, 't2', 'advanced');
    expect(readStance(vault, 't1')).toBe('beginner'); // t2's write did not clobber t1
    expect(readStance(vault, 't2')).toBe('advanced');
    setStance(vault, 't1', 'intermediate'); // a new stance command replaces the old
    expect(readStance(vault, 't1')).toBe('intermediate');
  });

  it('clearStance drops only the named thread and tolerates a missing entry', () => {
    const vault = freshVault();
    setStance(vault, 'keep', 'beginner');
    setStance(vault, 'gone', 'advanced');
    clearStance(vault, 'gone');
    clearStance(vault, 'never-existed'); // no-op, no throw, no file churn
    expect(readStances(vault)).toEqual({ keep: 'beginner' });
    expect(JSON.parse(readFileSync(join(vault, '.harness', 'stances.json'), 'utf8')))
      .toEqual({ keep: 'beginner' });
  });

  it('a corrupt or off-shape file reads as empty, and unknown values are dropped', () => {
    const vault = freshVault();
    mkdirSync(join(vault, '.harness'), { recursive: true });
    const p = join(vault, '.harness', 'stances.json');
    writeFileSync(p, '{ torn json');
    expect(readStances(vault)).toEqual({});
    // A hand-edited value outside the stance set must not smuggle a string into a prompt.
    writeFileSync(p, JSON.stringify({ ok: 'beginner', bad: 'expert', worse: 42 }));
    expect(readStances(vault)).toEqual({ ok: 'beginner' });
  });

  it('every stance has an instruction — the injection map cannot lag the command set', () => {
    for (const stance of STANCE_COMMANDS) {
      expect(STANCE_INSTRUCTIONS[stance]).toBeTruthy();
    }
  });
});
