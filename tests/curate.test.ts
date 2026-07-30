// The "who should I read?" ranking, pinned as ARITHMETIC. Every dep is injected, so nothing here
// touches Crossref, yt-dlp, or a live engram — which is also the point being tested: the list is
// index facts and counted evidence, so it comes out the same under any model, or none.
import { describe, it, expect, vi } from 'vitest';
import { buildReadingList, type CurateDeps } from '../src/server/curate.js';
import type { FrontierPaper } from '../src/server/frontierResearch.js';
import type { VideoHit } from '../src/server/videoSearch.js';

function paper(title: string, authors: string[], citations?: number): FrontierPaper {
  return {
    title, authors, date: '2011-01-01', source: 'Crossref',
    url: `https://doi.org/10/${title.toLowerCase().replace(/\s+/g, '-')}`,
    ...(citations === undefined ? {} : { citations }),
  };
}

function video(title: string, channel: string | undefined, views?: number, durationSeconds?: number): VideoHit {
  return {
    title, url: `https://www.youtube.com/watch?v=${title.replace(/\s+/g, '')}`,
    ...(channel ? { channel } : {}),
    ...(views === undefined ? {} : { views }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  };
}

function deps(over: Partial<CurateDeps> = {}): CurateDeps {
  return {
    findCanonicalPapers: async () => ({ papers: [], sourceErrors: [] }),
    searchVideos: async () => [],
    authorAffinity: async () => [],
    ...over,
  };
}

describe('buildReadingList — the ranking is arithmetic', () => {
  it('an author the learner has proven evidence from outranks a far more cited stranger', async () => {
    const list = await buildReadingList('memory', deps({
      findCanonicalPapers: async () => ({
        papers: [paper('Stranger', ['Nobody Known'], 90_000), paper('Familiar', ['Ada Lovelace'], 12)],
        sourceErrors: [],
      }),
      authorAffinity: async () => [{ author: 'Ada Lovelace', provenEvidence: 6, pages: 2 }],
    }));

    expect(list.recommendations.map((r) => r.title)).toEqual(['Familiar', 'Stranger']);
    expect(list.recommendations[0].knownAuthor).toBe(true);
    expect(list.recommendations[1].knownAuthor).toBe(false);
  });

  it('the affinity reason states the learner\'s own counted evidence, not a judgement', async () => {
    const list = await buildReadingList('memory', deps({
      findCanonicalPapers: async () => ({ papers: [paper('Familiar', ['Ada Lovelace'], 4182)], sourceErrors: [] }),
      authorAffinity: async () => [{ author: 'ada  LOVELACE ', provenEvidence: 6, pages: 2 }],
    }));

    // Case- and whitespace-insensitive match, same normalization provenance.ts applies to bylines.
    expect(list.recommendations[0].why).toEqual([
      'you have proven 6 evidence entries across 2 pages by ada  LOVELACE',
      '4,182 citations',
    ]);
  });

  it('an author with pages but no proven evidence is not a known author', async () => {
    const list = await buildReadingList('memory', deps({
      findCanonicalPapers: async () => ({ papers: [paper('Unproven', ['Ada Lovelace'], 5)], sourceErrors: [] }),
      authorAffinity: async () => [{ author: 'Ada Lovelace', provenEvidence: 0, pages: 3 }],
    }));

    expect(list.recommendations[0].knownAuthor).toBe(false);
    expect(list.recommendations[0].why).toEqual(['5 citations']);
  });

  it('papers order by citations, videos by views, and the two kinds interleave papers-first', async () => {
    const list = await buildReadingList('memory', deps({
      findCanonicalPapers: async () => ({
        papers: [paper('P low', ['A'], 10), paper('P high', ['B'], 900), paper('P mid', ['C'], 100)],
        sourceErrors: [],
      }),
      searchVideos: async () => [video('V mid', 'Chan', 500), video('V high', 'Chan', 9000)],
    }));

    expect(list.recommendations.map((r) => r.title))
      .toEqual(['P high', 'V high', 'P mid', 'V mid', 'P low']);
  });

  it('a missing count ranks last within its kind and says so instead of inventing a number', async () => {
    const list = await buildReadingList('memory', deps({
      findCanonicalPapers: async () => ({
        papers: [paper('No count', ['A']), paper('Counted', ['B'], 1)], sourceErrors: [],
      }),
      searchVideos: async () => [video('V no views', 'Chan'), video('V viewed', 'Chan', 2)],
    }));

    expect(list.recommendations.map((r) => r.title))
      .toEqual(['Counted', 'V viewed', 'No count', 'V no views']);
    expect(list.recommendations[2].why).toEqual(['Crossref reports no citation count for this one']);
    expect(list.recommendations[3].why).toEqual(['YouTube reports no view count for this one']);
  });

  it('formats large counts with thousands separators and reports a video\'s runtime', async () => {
    const list = await buildReadingList('memory', deps({
      searchVideos: async () => [video('Essence of calculus', '3Blue1Brown', 1_200_000, 840)],
    }));

    expect(list.recommendations[0].by).toEqual(['3Blue1Brown']);
    expect(list.recommendations[0].why).toEqual(['1,200,000 views', '14 min']);
  });

  it('caps the list at 8 while keeping both kinds in it', async () => {
    const list = await buildReadingList('memory', deps({
      findCanonicalPapers: async () => ({
        papers: Array.from({ length: 8 }, (_, i) => paper(`P${i}`, ['A'], 100 - i)), sourceErrors: [],
      }),
      searchVideos: async () => Array.from({ length: 8 }, (_, i) => video(`V${i}`, 'Chan', 100 - i)),
    }));

    expect(list.recommendations).toHaveLength(8);
    expect(list.recommendations.filter((r) => r.kind === 'paper')).toHaveLength(4);
    expect(list.recommendations.filter((r) => r.kind === 'video')).toHaveLength(4);
  });

  it('a video byline is the channel, verbatim', async () => {
    const list = await buildReadingList('memory', deps({
      searchVideos: async () => [video('Talk', 'Veritasium', 5)],
      authorAffinity: async () => [{ author: 'Veritasium', provenEvidence: 3, pages: 1 }],
    }));

    expect(list.recommendations[0].by).toEqual(['Veritasium']);
    expect(list.recommendations[0].knownAuthor).toBe(true);
  });
});

describe('buildReadingList — failure honesty', () => {
  it('one index down still returns the other, and names the one that failed', async () => {
    const list = await buildReadingList('memory', deps({
      findCanonicalPapers: async () => { throw new Error('no index reachable — Crossref: Crossref responded 503'); },
      searchVideos: async () => [video('Talk', 'Chan', 5)],
    }));

    expect(list.recommendations.map((r) => r.title)).toEqual(['Talk']);
    // findCanonicalPapers's own "no index reachable — Crossref: " wrapper is dropped, not stacked.
    expect(list.sourceErrors).toEqual(['Crossref: Crossref responded 503']);
  });

  it('yt-dlp missing does not blank the papers', async () => {
    const list = await buildReadingList('memory', deps({
      findCanonicalPapers: async () => ({ papers: [paper('P', ['A'], 5)], sourceErrors: [] }),
      searchVideos: async () => { throw new Error('yt-dlp is not installed'); },
    }));

    expect(list.recommendations.map((r) => r.title)).toEqual(['P']);
    expect(list.sourceErrors).toEqual(['YouTube: yt-dlp is not installed']);
  });

  it('both down returns an EMPTY list plus both errors — never a fabricated row', async () => {
    const list = await buildReadingList('memory', deps({
      findCanonicalPapers: async () => { throw new Error('Crossref responded 500'); },
      searchVideos: async () => { throw new Error('yt-dlp is not installed'); },
    }));

    expect(list.recommendations).toEqual([]);
    expect(list.sourceErrors).toEqual([
      'Crossref: Crossref responded 500',
      'YouTube: yt-dlp is not installed',
    ]);
  });

  it('nothing found is an empty list with NO errors — distinguishable from could not look', async () => {
    const list = await buildReadingList('quantum basket weaving', deps());
    expect(list).toEqual({ topic: 'quantum basket weaving', recommendations: [], sourceErrors: [] });
  });

  it('affinity failing costs the knownAuthor flag and nothing else', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const list = await buildReadingList('memory', deps({
      findCanonicalPapers: async () => ({ papers: [paper('P', ['Ada Lovelace'], 5)], sourceErrors: [] }),
      authorAffinity: async () => { throw new Error('engram is down'); },
    }));

    expect(list.recommendations[0].knownAuthor).toBe(false);
    expect(list.recommendations[0].why).toEqual(['5 citations']);
    // engram is not an index — its absence is not reported as one that could not be reached.
    expect(list.sourceErrors).toEqual([]);
    err.mockRestore();
  });
});
