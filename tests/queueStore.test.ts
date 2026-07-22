import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQueue, updateQueue, type QueueEntry } from '../src/server/queueStore.js';

function seedLedger(entries: QueueEntry[]): string {
  const vault = mkdtempSync(join(tmpdir(), 'lwh-queuestore-'));
  mkdirSync(join(vault, '.harness'), { recursive: true });
  writeFileSync(join(vault, '.harness', 'compile-queue.json'), JSON.stringify(entries));
  return vault;
}

describe('updateQueue — the lost-update regression', () => {
  it(
    'interleaves two async flows (one adding rows, one patching an existing row after an await) — '
    + 'the final file contains BOTH changes, reproducing the exact shape of the 2026-07-21 incident '
    + '(a repo ingest\'s placeholder + 14 doc-chapter rows erased by a long-running compile\'s stale write)',
    async () => {
      const vault = seedLedger([
        { book: 'Existing Book', chapter: 'raw/uploads/existing/ch-01-a.md', title: 'Chapter A', status: 'pending' },
      ]);

      let releasePatch: () => void;
      const gate = new Promise<void>((resolve) => { releasePatch = resolve; });

      // Flow 1 mirrors compileOne: it does some slow work (a long LLM call, here just an awaited
      // gate) and only AFTER that await does it call updateQueue to patch the row it claimed.
      const patchFlow = (async () => {
        await gate;
        await updateQueue(vault, (entries) => {
          const e = entries.find((x) => x.chapter === 'raw/uploads/existing/ch-01-a.md');
          if (e) e.status = 'done';
        });
      })();

      // Flow 2 mirrors ingestRepo's docs pass: it adds 15 new rows via updateQueue (one placeholder
      // + 14 chapters) WHILE flow 1 is still gated mid-"compile" — exactly the window in which the
      // pre-fix code (a single ledger array read once by compileNext and written back wholesale by
      // compileOne's finally block, long after these rows landed) silently erased them.
      const addFlow = (async () => {
        await updateQueue(vault, (entries) => {
          entries.push({
            book: 'my-repo', chapter: '__ingesting_repo__/x', title: 'Ingesting repo…',
            mode: 'repo', status: 'converting',
          });
        });
        for (let i = 1; i <= 14; i++) {
          await updateQueue(vault, (entries) => {
            entries.push({
              book: 'my-repo', chapter: `raw/uploads/my-repo/doc--ch-${String(i).padStart(2, '0')}.md`,
              title: `Doc chapter ${i}`, status: 'pending', sourceUrl: `/local/repo — doc.md`,
            });
          });
        }
        // Only release the patch flow once all 15 additions have actually landed on disk — this is
        // the adversarial ordering: the patching write happens strictly AFTER the adding writes.
        releasePatch!();
      })();

      await Promise.all([patchFlow, addFlow]);

      const final = readQueue(vault);
      // The pre-existing entry's patch survived.
      expect(final.find((e) => e.chapter === 'raw/uploads/existing/ch-01-a.md')?.status).toBe('done');
      // All 15 concurrently-added rows survived — none clobbered.
      expect(final.filter((e) => e.book === 'my-repo')).toHaveLength(15);
      expect(final).toHaveLength(16);
    },
  );

  it('many concurrent pushes with no coordination at all — every single one survives (classic lost-update race)', async () => {
    const vault = seedLedger([]);
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) => updateQueue(vault, (entries) => {
        entries.push({ book: 'Race Book', chapter: `raw/uploads/race/ch-${i}.md`, title: `Chapter ${i}`, status: 'pending' });
      })),
    );
    const final = readQueue(vault);
    expect(final).toHaveLength(N);
    expect(new Set(final.map((e) => e.chapter)).size).toBe(N); // every one is distinct — none overwrote another
  });

  it('supports both mutation styles: mutate-in-place (push/find+patch) and return-a-new-array (filter)', async () => {
    const vault = seedLedger([
      { book: 'B', chapter: 'raw/uploads/b/ch-01.md', title: 'One', status: 'pending' },
      { book: 'B', chapter: '__converting__/ph', title: 'Converting…', status: 'converting' },
    ]);
    await updateQueue(vault, (entries) => entries.filter((e) => e.chapter !== '__converting__/ph'));
    expect(readQueue(vault)).toHaveLength(1);
    expect(readQueue(vault)[0].chapter).toBe('raw/uploads/b/ch-01.md');
  });

  it('a throwing mutator rejects only its own caller — later callers against the same vault still run', async () => {
    const vault = seedLedger([]);
    await expect(updateQueue(vault, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await updateQueue(vault, (entries) => {
      entries.push({ book: 'After Failure', chapter: 'raw/uploads/af/ch-01.md', title: 'One', status: 'pending' });
    });
    const final = readQueue(vault);
    expect(final).toHaveLength(1);
    expect(final[0].book).toBe('After Failure');
  });

  it('two vaults never serialize against each other — independent mutex slots', async () => {
    const vaultA = seedLedger([]);
    const vaultB = seedLedger([]);
    await Promise.all([
      updateQueue(vaultA, (entries) => { entries.push({ book: 'A', chapter: 'a', title: 'A', status: 'pending' }); }),
      updateQueue(vaultB, (entries) => { entries.push({ book: 'B', chapter: 'b', title: 'B', status: 'pending' }); }),
    ]);
    expect(readQueue(vaultA)).toHaveLength(1);
    expect(readQueue(vaultB)).toHaveLength(1);
  });
});
