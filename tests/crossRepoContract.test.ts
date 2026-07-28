// The harness MIRRORS loreweaver's mastery contract (src/shared/loreweaver.ts) rather than
// importing it — they are separate packages. A mirror rots silently: if loreweaver ever tunes a
// decay window or reorders a level, the harness would keep grading, scheduling digests, and
// drawing due-badges against the OLD numbers, and nothing anywhere would fail. This test is the
// tripwire: it imports the real loreweaver's own constants from the sibling checkout (resolved by
// tests/lwRepo.ts, the same sibling layout every other integration test and the e2e configs rely
// on) and demands exact agreement.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DECAY, LEVELS } from '../src/shared/loreweaver.js';
import { LW_REPO } from './lwRepo.js';


describe('the mirrored mastery contract matches the real loreweaver', () => {
  it('decay windows agree exactly', async () => {
    const theirs = await import(join(LW_REPO, 'src/types.ts'));
    expect(DECAY).toEqual(theirs.DECAY);
  });

  it('mastery levels agree exactly, order included — indexOf comparisons depend on it', async () => {
    const theirs = await import(join(LW_REPO, 'src/types.ts'));
    expect(LEVELS).toEqual(theirs.LEVELS);
  });
});
