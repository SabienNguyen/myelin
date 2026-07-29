import { describe, it, expect } from 'vitest';
import { parseSearchJson, searchVideos } from '../src/server/videoSearch.js';

// The two flat-playlist entry shapes yt-dlp emits across versions: full webpage URLs, and bare ids.
const DUMP = JSON.stringify({
  entries: [
    {
      id: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk',
      title: 'The Quadratic Formula — derived', channel: 'Khan Academy', duration: 372.5, view_count: 1_200_000,
    },
    { id: 'LMNOPQRSTUV', url: 'LMNOPQRSTUV', title: 'Completing the square', uploader: 'Some Channel' },
    { id: null, url: null, title: 'malformed row — dropped' },
  ],
});

describe('parseSearchJson', () => {
  it('normalizes both entry shapes to full watch URLs and keeps the useful metadata', () => {
    const hits = parseSearchJson(DUMP);
    expect(hits).toEqual([
      {
        title: 'The Quadratic Formula — derived',
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        channel: 'Khan Academy',
        durationSeconds: 373,
        views: 1_200_000,
      },
      {
        title: 'Completing the square',
        url: 'https://www.youtube.com/watch?v=LMNOPQRSTUV',
        channel: 'Some Channel',
      },
    ]);
  });

  it('an empty or entry-less dump is no hits, not a crash', () => {
    expect(parseSearchJson('{}')).toEqual([]);
    expect(parseSearchJson('{"entries": []}')).toEqual([]);
  });
});

describe('searchVideos', () => {
  it('shells ytsearchN with the query and parses the dump', async () => {
    const calls: string[][] = [];
    const hits = await searchVideos('quadratic formula', 3, {
      exec: async (_cmd, args) => { calls.push(args); return { stdout: DUMP }; },
    });
    expect(hits).toHaveLength(2);
    expect(calls[0]).toContain('ytsearch3:quadratic formula');
    expect(calls[0]).toContain('--flat-playlist');
  });

  it('limit is clamped to the 1..10 the tool schema promises', async () => {
    const calls: string[][] = [];
    const exec = async (_c: string, args: string[]) => { calls.push(args); return { stdout: '{}' }; };
    await searchVideos('q', 50, { exec });
    await searchVideos('q', 0, { exec });
    expect(calls[0].at(-1)).toBe('ytsearch10:q');
    expect(calls[1].at(-1)).toBe('ytsearch1:q');
  });

  it('a missing yt-dlp binary fails with the actionable install message', async () => {
    await expect(searchVideos('q', 5, {
      exec: async () => { throw Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }); },
    })).rejects.toThrow(/yt-dlp is not installed/);
  });
});
