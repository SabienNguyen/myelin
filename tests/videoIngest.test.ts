import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchVideoTranscript, isVideoUrl, linkifyTimestamps, parseVtt, transcriptMarkdown, type ExecLike,
} from '../src/server/videoIngest.js';

describe('isVideoUrl — conservative YouTube-shape detection', () => {
  it.each([
    'https://www.youtube.com/watch?v=abc123',
    'https://youtube.com/watch?v=abc123&t=42',
    'https://m.youtube.com/watch?v=abc123',
    'https://youtu.be/abc123',
    'https://www.youtube.com/shorts/abc123',
    'https://www.youtube.com/live/abc123',         // recorded livestream lecture
    'https://www.youtube.com/embed/abc123',        // iframe src copied off a course page
  ])('accepts %s', (url) => expect(isVideoUrl(url)).toBe(true));

  it.each([
    'https://arxiv.org/abs/1706.03762',
    'https://example.com/watch?v=abc',            // watch path on a non-YouTube host
    'https://github.com/someone/youtube-dl',       // the word, not the site
    'https://www.youtube.com/@3blue1brown',        // channel page, nothing to transcribe
    '/home/user/lecture.mp4',                      // local files are not wired (no captions)
  ])('rejects %s', (url) => expect(isVideoUrl(url)).toBe(false));
});

const VTT = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:03.500 align:start position:0%
so<00:00:01.319> today<00:00:01.680> we're<00:00:02.000> looking<00:00:02.400> at

00:00:03.500 --> 00:00:06.000
so today we're looking at
the derivative as a slope

00:00:06.000 --> 00:00:09.000
the derivative as a slope
<c>not just a formula</c>

NOTE this block is metadata, not speech

01:02:03.000 --> 01:02:05.000
an hour in
`;

describe('parseVtt', () => {
  it('flattens rolling auto-captions into non-repeating cues', () => {
    const cues = parseVtt(VTT);
    expect(cues.map((c) => c.text)).toEqual([
      "so today we're looking at",
      'the derivative as a slope',
      'not just a formula',
      'an hour in',
    ]);
  });

  it('keeps cue start times, including past the hour', () => {
    const cues = parseVtt(VTT);
    expect(cues[0].start).toBe(1);
    expect(cues.at(-1)!.start).toBe(3723);
  });

  it('strips inline word-timing and styling tags', () => {
    const joined = parseVtt(VTT).map((c) => c.text).join(' ');
    expect(joined).not.toMatch(/[<>]/);
  });
});

describe('transcriptMarkdown', () => {
  const meta = {
    title: 'The essence of calculus', channel: '3Blue1Brown',
    duration: '17:04', url: 'https://youtu.be/abc',
  };

  it('opens with the title as H1 (paper mode titles from it) and links back to the video', () => {
    const md = transcriptMarkdown(meta, parseVtt(VTT));
    expect(md.startsWith('# The essence of calculus\n')).toBe(true);
    expect(md).toContain('3Blue1Brown · 17:04 · [watch](https://youtu.be/abc)');
  });

  it('stamps blocks as [M:SS] deep links into the video, [H:MM:SS] past the hour', () => {
    const md = transcriptMarkdown(meta, parseVtt(VTT));
    // Each stamp links to its second — clicking [0:01] in the reader opens the video there.
    expect(md).toContain('**[\\[0:01\\]](https://youtu.be/abc?t=1s)**');
    expect(md).toContain('**[\\[1:02:03\\]](https://youtu.be/abc?t=3723s)**');
  });

  it('deep links append with & when the URL already carries a query', () => {
    const md = transcriptMarkdown({ ...meta, url: 'https://www.youtube.com/watch?v=abc' }, parseVtt(VTT));
    expect(md).toContain('(https://www.youtube.com/watch?v=abc&t=1s)');
  });
});

describe('linkifyTimestamps — compiled-page stamps become deep links', () => {
  const URL = 'https://www.youtube.com/watch?v=abc';

  it('links plain stamps, parenthesized or bare, minute and hour forms', () => {
    const out = linkifyTimestamps('slice the disk ([1:05]) and see [1:02:03] for the theorem', URL);
    expect(out).toContain('([\\[1:05\\]](https://www.youtube.com/watch?v=abc&t=65s))');
    expect(out).toContain('[\\[1:02:03\\]](https://www.youtube.com/watch?v=abc&t=3723s)');
  });

  it('leaves stamps that are already links untouched', () => {
    const already = 'see [\\[0:12\\]](https://youtu.be/x?t=12s) and [2:40](https://youtu.be/x?t=160s)';
    expect(linkifyTimestamps(already, URL)).toBe(already);
  });

  it('idempotent: a second pass changes nothing', () => {
    const once = linkifyTimestamps('the rings appear at [2:40].', URL);
    expect(linkifyTimestamps(once, URL)).toBe(once);
  });

  it('does not invent links from non-time bracket text', () => {
    const text = 'a citation [12] and a matrix [1,2] and prose [see below]';
    expect(linkifyTimestamps(text, URL)).toBe(text);
  });

  it('leaves a [1:30]-style slice in code alone — a coding video is not a timestamp mine', () => {
    // A programming video compiles to a page with code; `arr[1:30]` and `x[0:10]` are slices, not
    // moments. Fenced and inline code must pass through verbatim while prose stamps still link.
    const fenced = 'Prose stamp [1:05]:\n```python\nchunk = arr[1:30]\nrow = m[0:10]\n```\nback to [2:40].';
    const out = linkifyTimestamps(fenced, URL);
    expect(out).toContain('chunk = arr[1:30]');   // code untouched
    expect(out).toContain('row = m[0:10]');
    expect(out).toContain('[\\[1:05\\]](');        // prose stamps still linked
    expect(out).toContain('[\\[2:40\\]](');
    // inline code too
    expect(linkifyTimestamps('use `arr[1:30]` to slice', URL)).toBe('use `arr[1:30]` to slice');
  });
});

/** Fake yt-dlp: answers --print with metadata, and "writes" captions by dropping a .vtt beside
 *  the -o prefix — the same observable behavior the real binary has. */
function fakeYtDlp(opts: { manualVtt?: string; autoVtt?: string }): ExecLike & { calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecLike = async (cmd, args) => {
    calls.push(args);
    if (cmd !== 'yt-dlp') throw new Error(`unexpected command ${cmd}`);
    if (args.includes('--print')) return { stdout: 'Attention Is All You Watch\nSome Channel\n12:34\n' };
    const prefix = args[args.indexOf('-o') + 1];
    if (args.includes('--write-subs') && opts.manualVtt) writeFileSync(`${prefix}.en.vtt`, opts.manualVtt);
    if (args.includes('--write-auto-subs') && opts.autoVtt) writeFileSync(`${prefix}.en.vtt`, opts.autoVtt);
    return { stdout: '' };
  };
  return Object.assign(exec, { calls });
}

describe('fetchVideoTranscript', () => {
  it('uses manual captions without ever asking for auto ones', async () => {
    const exec = fakeYtDlp({ manualVtt: VTT, autoVtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nwrong track\n' });
    const { title, markdown } = await fetchVideoTranscript('https://youtu.be/abc', { exec });
    expect(title).toBe('Attention Is All You Watch');
    expect(markdown).toContain("so today we're looking at");
    expect(markdown).not.toContain('wrong track');
    expect(exec.calls.some((a) => a.includes('--write-auto-subs'))).toBe(false);
  });

  it('falls back to auto captions when no manual track exists', async () => {
    const exec = fakeYtDlp({ autoVtt: VTT });
    const { markdown } = await fetchVideoTranscript('https://youtu.be/abc', { exec });
    expect(markdown).toContain('the derivative as a slope');
    expect(exec.calls.some((a) => a.includes('--write-auto-subs'))).toBe(true);
  });

  it('a caption-less video is an honest error naming the parked Whisper path', async () => {
    const exec = fakeYtDlp({});
    await expect(fetchVideoTranscript('https://youtu.be/abc', { exec }))
      .rejects.toThrow(/no captions .*Whisper.*parked/s);
  });

  it('a missing yt-dlp binary says exactly what to install', async () => {
    const exec: ExecLike = async () => { throw Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }); };
    await expect(fetchVideoTranscript('https://youtu.be/abc', { exec }))
      .rejects.toThrow(/yt-dlp is not installed.*pipx install yt-dlp/s);
  });

  it('never downloads the video itself: every yt-dlp call carries --skip-download', async () => {
    const exec = fakeYtDlp({ manualVtt: VTT });
    await fetchVideoTranscript('https://youtu.be/abc', { exec });
    expect(exec.calls.every((a) => a.includes('--skip-download'))).toBe(true);
  });
});

describe('POST /api/ingest with a video URL', () => {
  const makeVault = () => mkdtempSync(join(tmpdir(), 'lwh-video-vault-'));

  async function buildApp(vault: string, exec: ExecLike) {
    const { buildIngestRoutes } = await import('../src/server/ingestRoutes.js');
    const lw = { listSlugs: async () => [], call: async () => ({}) } as any;
    const cfg = { vault, student: 'kid' } as any;
    // Pass-through converter: the transcript is already markdown.
    const converter = async (file: string) => ({ markdown: (await import('node:fs')).readFileSync(file, 'utf8') });
    return buildIngestRoutes(lw, cfg, { converter, videoDeps: { exec } });
  }

  it('routes a YouTube URL through captions into a converting paper', async () => {
    const app = await buildApp(makeVault(), fakeYtDlp({ manualVtt: VTT }));
    const res = await app.request('/api/ingest', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc123' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ book: 'Attention Is All You Watch', converting: true });
  });

  it('surfaces the yt-dlp installHint as a 400, not a queue entry', async () => {
    const vault = makeVault();
    const exec: ExecLike = async () => { throw Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }); };
    const app = await buildApp(vault, exec);
    const res = await app.request('/api/ingest', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://youtu.be/abc123' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/yt-dlp is not installed/);
    const { readQueue } = await import('../src/server/ingest.js');
    expect(readQueue(vault)).toEqual([]);
  });
});
