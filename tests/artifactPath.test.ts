import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureArtifactPaths, artifactPathSlug } from '../src/server/artifactPath.js';
import { recordSource, type SourceRecord } from '../src/server/provenance.js';
import { writeQueue, type QueueEntry, type QueueStatus } from '../src/server/queueStore.js';
import type { HarnessConfig } from '../src/server/config.js';

/** A vault with a source record and a settled ledger — the state a finished drain leaves behind. */
function vaultWith(opts: {
  spine?: SourceRecord['spine'];
  authors?: string[];
  statuses?: QueueStatus[];
  extraRows?: QueueEntry[];
}): { vault: string; cfg: HarnessConfig } {
  const vault = mkdtempSync(join(tmpdir(), 'lwh-artifact-path-'));
  const spine = opts.spine ?? [];
  recordSource(vault, {
    book: 'Nonlinear Dynamics and Chaos',
    title: 'Nonlinear Dynamics and Chaos',
    authors: opts.authors ?? ['Steven Strogatz'],
    attribution: 'verified',
    origin: { kind: 'file' },
    addedAt: '2026-07-30T00:00:00.000Z',
    ...(spine.length ? { spine } : {}),
  });
  const statuses = opts.statuses ?? spine.map(() => 'done' as const);
  writeQueue(vault, [
    ...spine.map((s, i) => ({
      book: 'Nonlinear Dynamics and Chaos',
      chapter: s.chapter,
      title: s.title,
      status: statuses[i] ?? 'done',
    })),
    ...(opts.extraRows ?? []),
  ]);
  return { vault, cfg: { vault, student: 'kid', models: {} } as unknown as HarnessConfig };
}

const chapter = (n: number, title: string, pages: string[]) => ({
  chapter: `raw/uploads/nonlinear-dynamics-and-chaos/ch-0${n}-${title}.md`,
  chapterOrdinal: n,
  title,
  pages,
});

/** Records every create_path call; answers list_pages from `prereqs`. */
function fakeLw(known: string[], prereqs: Record<string, string[]> = {}) {
  const calls: { name: string; args: any }[] = [];
  return {
    calls,
    lw: {
      listSlugs: async () => known,
      call: async (name: string, args: any) => {
        calls.push({ name, args });
        if (name === 'list_pages') {
          return { pages: known.map((slug) => ({ slug, prereqs: prereqs[slug] ?? [] })) };
        }
        return { created: args.slug };
      },
    } as any,
  };
}

const guardrailLog = (vault: string) => {
  const p = join(vault, '.harness', 'guardrail.log');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

describe('ensureArtifactPaths — the book\'s own order becomes the path', () => {
  it('orders stops by chapter, and within a chapter by the order compile wrote them', async () => {
    // The whole feature: this is the sequence Strogatz chose, not one we derived. Chapter 2's pages
    // follow chapter 1's, and inside each chapter the write_page call order is preserved verbatim.
    const { vault, cfg } = vaultWith({
      spine: [
        chapter(1, 'flows-on-the-line', ['fixed-points', 'stability', 'linear-stability-analysis']),
        chapter(2, 'bifurcations', ['saddle-node-bifurcation', 'transcritical-bifurcation']),
      ],
    });
    const { lw, calls } = fakeLw([
      'stability', 'fixed-points', 'linear-stability-analysis',
      'transcritical-bifurcation', 'saddle-node-bifurcation',
    ]);

    const created = await ensureArtifactPaths(lw, cfg);

    expect(created).toEqual([artifactPathSlug('Nonlinear Dynamics and Chaos')]);
    const path = calls.find((c) => c.name === 'create_path')!.args;
    expect(path.pages).toEqual([
      'fixed-points', 'stability', 'linear-stability-analysis',
      'saddle-node-bifurcation', 'transcritical-bifurcation',
    ]);
    expect(path.slug).toBe('source-nonlinear-dynamics-and-chaos');
    expect(path.title).toBe('Nonlinear Dynamics and Chaos');
    expect(path.narrative).toContain('Steven Strogatz');
    expect(path.narrative).toMatch(/order the source itself presents|book's own/);
  });

  it('a spine recorded out of order still teaches in the book\'s order', async () => {
    // Chapters compile four at a time, so chapter 3 can finish before chapter 1 — the ordinal
    // decides the path, never the order the drain happened to settle in.
    const { vault, cfg } = vaultWith({
      spine: [
        chapter(3, 'c', ['third-page']),
        chapter(1, 'a', ['first-page']),
        chapter(2, 'b', ['second-page']),
      ],
    });
    const { lw, calls } = fakeLw(['third-page', 'first-page', 'second-page']);
    await ensureArtifactPaths(lw, cfg);
    expect(calls.find((c) => c.name === 'create_path')!.args.pages)
      .toEqual(['first-page', 'second-page', 'third-page']);
  });

  it('one chapter is not a spine — a single-unit source gets no path', async () => {
    const { vault, cfg } = vaultWith({
      spine: [chapter(1, 'the-whole-thing', ['attention', 'self-attention'])],
    });
    const { lw, calls } = fakeLw(['attention', 'self-attention']);
    expect(await ensureArtifactPaths(lw, cfg)).toEqual([]);
    expect(calls.filter((c) => c.name === 'create_path')).toEqual([]);
  });

  it('waits for every chapter: a source with work still pending gets no path yet', async () => {
    // A path built mid-drain presents half a book as the whole of it.
    const { vault, cfg } = vaultWith({
      spine: [chapter(1, 'a', ['page-a']), chapter(2, 'b', ['page-b'])],
      statuses: ['done', 'pending'],
    });
    const { lw, calls } = fakeLw(['page-a', 'page-b']);
    expect(await ensureArtifactPaths(lw, cfg)).toEqual([]);
    expect(calls.filter((c) => c.name === 'create_path')).toEqual([]);
  });

  it('an errored chapter counts as settled — its book still gets its path', async () => {
    // An errored chapter is not coming back on its own; withholding the path forever would punish
    // the chapters that compiled fine.
    const { vault, cfg } = vaultWith({
      spine: [chapter(1, 'a', ['page-a']), chapter(2, 'b', ['page-b'])],
      statuses: ['done', 'error'],
    });
    const { lw, calls } = fakeLw(['page-a', 'page-b']);
    expect(await ensureArtifactPaths(lw, cfg)).toHaveLength(1);
    expect(calls.find((c) => c.name === 'create_path')!.args.pages).toEqual(['page-a', 'page-b']);
  });

  it('a leftover conversion placeholder does not withhold the path', async () => {
    // sweepInterruptedConversions leaves `convert-error` placeholders behind forever; they are
    // conversion bookkeeping, not chapters.
    const { vault, cfg } = vaultWith({
      spine: [chapter(1, 'a', ['page-a']), chapter(2, 'b', ['page-b'])],
      extraRows: [{
        book: 'Nonlinear Dynamics and Chaos', chapter: '__converting__/abc',
        title: 'Converting…', status: 'convert-error',
      }],
    });
    const { lw } = fakeLw(['page-a', 'page-b']);
    expect(await ensureArtifactPaths(lw, cfg)).toHaveLength(1);
  });

  it('drops slugs the vault no longer holds and keeps the rest of the spine', async () => {
    // create_path rejects a path containing an unknown page, so one page deleted in Obsidian would
    // otherwise cost the entire ordering.
    const { vault, cfg } = vaultWith({
      spine: [chapter(1, 'a', ['page-a', 'deleted-in-obsidian']), chapter(2, 'b', ['page-b'])],
    });
    const { lw, calls } = fakeLw(['page-a', 'page-b']);
    await ensureArtifactPaths(lw, cfg);
    expect(calls.find((c) => c.name === 'create_path')!.args.pages).toEqual(['page-a', 'page-b']);
  });

  it('a source whose every page is gone gets no path at all', async () => {
    const { vault, cfg } = vaultWith({
      spine: [chapter(1, 'a', ['page-a']), chapter(2, 'b', ['page-b'])],
    });
    const { lw, calls } = fakeLw([]);
    expect(await ensureArtifactPaths(lw, cfg)).toEqual([]);
    expect(calls.filter((c) => c.name === 'create_path')).toEqual([]);
  });

  it('keeps the book\'s order over the prereq graph, and logs the disagreement', async () => {
    // The deliberate policy: page-a is taught before page-c even though page-a lists page-c as a
    // prereq. A good expositor introduces an idea before its formal prerequisite on purpose, so the
    // author wins and the disagreement is reported rather than repaired.
    const { vault, cfg } = vaultWith({
      spine: [chapter(1, 'a', ['page-a']), chapter(2, 'b', ['page-b', 'page-c'])],
    });
    const { lw, calls } = fakeLw(['page-a', 'page-b', 'page-c'], { 'page-a': ['page-c'] });

    await ensureArtifactPaths(lw, cfg);

    expect(calls.find((c) => c.name === 'create_path')!.args.pages)
      .toEqual(['page-a', 'page-b', 'page-c']); // NOT reordered
    const log = guardrailLog(vault);
    expect(log).toContain('source-nonlinear-dynamics-and-chaos');
    expect(log).toContain('1 prereq disagreement');
    expect(log).toContain('"page-a" (stop 1) is taught before its prereq "page-c" (stop 3)');
  });

  it('a book that disagrees everywhere logs one bounded finding, not a wall of them', async () => {
    const early = Array.from({ length: 7 }, (_, i) => `early-${i}`);
    const { vault, cfg } = vaultWith({
      spine: [chapter(1, 'a', early), chapter(2, 'b', ['late-machinery'])],
    });
    const { lw } = fakeLw(
      [...early, 'late-machinery'],
      Object.fromEntries(early.map((slug) => [slug, ['late-machinery']])),
    );

    await ensureArtifactPaths(lw, cfg);

    const log = guardrailLog(vault);
    expect(log).toContain('7 prereq disagreement');
    expect(log).toContain('and 2 more');
    expect(log.trimEnd().split('\n')).toHaveLength(1);
  });

  it('a path the graph agrees with logs nothing', async () => {
    const { vault, cfg } = vaultWith({
      spine: [chapter(1, 'a', ['page-a']), chapter(2, 'b', ['page-b'])],
    });
    const { lw } = fakeLw(['page-a', 'page-b'], { 'page-b': ['page-a'] });
    await ensureArtifactPaths(lw, cfg);
    expect(guardrailLog(vault)).toBe('');
  });

  it('a rejected create_path is logged and skipped, never thrown at the drain', async () => {
    const { vault, cfg } = vaultWith({
      spine: [chapter(1, 'a', ['page-a']), chapter(2, 'b', ['page-b'])],
    });
    const lw = {
      listSlugs: async () => ['page-a', 'page-b'],
      call: async (name: string) => {
        if (name === 'create_path') throw new Error('engram create_path: pages not found: page-b');
        return { pages: [] };
      },
    } as any;
    await expect(ensureArtifactPaths(lw, cfg)).resolves.toEqual([]);
  });

  it('recompiling refreshes the same path slug rather than minting a second one', async () => {
    const { vault, cfg } = vaultWith({
      spine: [chapter(1, 'a', ['page-a']), chapter(2, 'b', ['page-b'])],
    });
    const { lw, calls } = fakeLw(['page-a', 'page-b']);
    const first = await ensureArtifactPaths(lw, cfg);
    const second = await ensureArtifactPaths(lw, cfg);
    expect(second).toEqual(first);
    const slugs = calls.filter((c) => c.name === 'create_path').map((c) => c.args.slug);
    expect(new Set(slugs).size).toBe(1);
  });

  it('an unattributed source gets a narrative that names no author rather than an empty byline', async () => {
    const { vault, cfg } = vaultWith({
      spine: [chapter(1, 'a', ['page-a']), chapter(2, 'b', ['page-b'])],
      authors: [],
    });
    const { lw, calls } = fakeLw(['page-a', 'page-b']);
    await ensureArtifactPaths(lw, cfg);
    const { narrative } = calls.find((c) => c.name === 'create_path')!.args;
    expect(narrative).not.toContain(' by ');
    expect(narrative).toContain('Nonlinear Dynamics and Chaos');
  });

  it('a vault with no recorded spines makes no engram calls at all', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-artifact-path-empty-'));
    mkdirSync(join(vault, '.harness'), { recursive: true });
    writeFileSync(join(vault, '.harness', 'sources.json'), '[]');
    const { lw, calls } = fakeLw(['page-a']);
    expect(await ensureArtifactPaths(lw, { vault } as unknown as HarnessConfig)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
