import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Video URLs through the same single "Add material" door as everything else.
 *
 * Educational video is exactly the artifact class the librarian principle exists for — a
 * 3blue1brown episode or a recorded lecture is a human teaching artifact, and the tutor's job is
 * to bring the learner TO it, not to paraphrase it from memory. What the vault can actually hold
 * and teach from is the video's TRANSCRIPT, timestamped, so the source reader shows where in the
 * video each passage lives and select-to-ask works on lecture prose like on any paper.
 *
 * Strategy borrowed from the claude-video skill (bradautomates/claude-video, MIT): captions
 * first, always. yt-dlp can fetch a video's own captions without downloading a single frame —
 * for educational YouTube that covers nearly everything, free and in seconds. What this module
 * deliberately does NOT do (parked, in the open): Whisper transcription for caption-less videos
 * (needs an API key and audio download) and frame extraction (megabytes of images for content
 * whose teaching value here is the prose). A caption-less video gets an honest error, not a
 * silent degradation.
 *
 * yt-dlp itself is an install-on-demand dependency like nvcc or docker (see gap/exec.ts's
 * installHint pattern): absent, the error says exactly what to install.
 */

const execFileAsync = promisify(execFile);

/** Minimal executor seam so tests can fake yt-dlp without a network or a binary. */
export type ExecLike = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

export interface VideoIngestDeps {
  exec?: ExecLike;
}

export { isVideoUrl } from '../shared/videoUrl.js';

export interface Cue { start: number; text: string }

const TIMING_LINE = /^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\s+-->\s/;
const SHORT_TIMING_LINE = /^(\d{1,2}):(\d{2})[.,](\d{3})\s+-->\s/;

/**
 * Parse WebVTT into deduplicated cues.
 *
 * YouTube auto-captions are ROLLING: each cue repeats the previous line and appends the next, so
 * a naive join reads every sentence twice. The dedup here is line-level against the last emitted
 * line, which flattens the rolling window back into prose while leaving legitimate repetition
 * (a chorus, a repeated definition) intact when it isn't adjacent.
 */
export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  let lastLine = '';
  for (const block of vtt.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timingIdx = lines.findIndex((l) => TIMING_LINE.test(l) || SHORT_TIMING_LINE.test(l));
    if (timingIdx === -1) continue; // WEBVTT header, NOTE blocks, style blocks
    const timing = lines[timingIdx];
    let start: number;
    const long = timing.match(TIMING_LINE);
    if (long) start = Number(long[1]) * 3600 + Number(long[2]) * 60 + Number(long[3]);
    else {
      const short = timing.match(SHORT_TIMING_LINE)!;
      start = Number(short[1]) * 60 + Number(short[2]);
    }
    for (const raw of lines.slice(timingIdx + 1)) {
      // Inline tags: <c>…</c> styling and <00:00:01.319> word timings both go.
      const text = raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (!text || text === lastLine) continue;
      cues.push({ start, text });
      lastLine = text;
    }
  }
  return cues;
}

const stamp = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
};

export interface VideoMeta { title: string; channel: string; duration: string; url: string }

/** The video URL with a start-time parameter — one definition, shared with the client's
 *  watch_video block (videoUrl.ts). Re-exported so this module's callers keep their import. */
import { atTime } from '../shared/videoUrl.js';

export { atTime };

/**
 * Turn plain [M:SS] / [H:MM:SS] references into deep links to those seconds of the video.
 *
 * Compiled pages cite transcript moments as "([2:40])" — the compile model keeps the stamps as
 * citation anchors, but as dead text. This runs mechanically over write_page bodies during a
 * video-sourced compile (the same seam that guarantees citations — ingest.ts's withCitation), so
 * a learner reading the COMPILED page can jump into the video exactly like a learner reading the
 * raw transcript. Stamps that are already link text (\[0:12\]) or link labels stay untouched.
 *
 * Fenced and inline code are skipped: a video ABOUT programming compiles to a page carrying code,
 * and `arr[1:30]` / `list[0:10]` are slice literals, not timestamps — linkifying them would turn
 * the code into broken deep links. The split keeps each code run (odd index) verbatim and only
 * rewrites the prose between (even index), the same code-protection the chat preprocessors use.
 */
export function linkifyTimestamps(markdown: string, videoUrl: string): string {
  return markdown
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((seg, i) => (i % 2 ? seg : seg.replace(
      /(\\?)\[(\d{1,2}):(\d{2})(?::(\d{2}))?\](\]\(|\()?/g,
      (whole, escaped, a, b, c, tail) => {
        if (escaped || tail === '](' || tail === '(') return whole; // already a link, or link syntax
        const seconds = c ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b);
        const label = c ? `${a}:${b}:${c}` : `${a}:${b}`;
        return `[\\[${label}\\]](${atTime(videoUrl, seconds)})`;
      },
    )))
    .join('');
}

/** Cues grouped into readable timestamped paragraphs. One [M:SS] per ~500 characters of speech —
 *  dense enough to find a moment in the video, sparse enough to read as prose. Each stamp is a
 *  DEEP LINK to that second of the video (Electron routes external links to the system browser),
 *  so "scrub to [1:05]" is one click in the reader, not a manual seek. */
export function transcriptMarkdown(meta: VideoMeta, cues: Cue[]): string {
  const blocks: { start: number; parts: string[] }[] = [];
  let current: { start: number; parts: string[]; chars: number } | null = null;
  let lastStart = -Infinity;
  for (const cue of cues) {
    // New paragraph on length OR on a silence: >30s between cues means the speaker moved on
    // (a chapter break, a demo) and stitching across it would timestamp prose an hour wrong.
    if (!current || current.chars > 500 || cue.start - lastStart > 30) {
      current = { start: cue.start, parts: [], chars: 0 };
      blocks.push(current);
    }
    current.parts.push(cue.text);
    current.chars += cue.text.length + 1;
    lastStart = cue.start;
  }
  const body = blocks
    .map((b) => `**[\\[${stamp(b.start)}\\]](${atTime(meta.url, b.start)})** ${b.parts.join(' ')}`)
    .join('\n\n');
  return [
    `# ${meta.title}`,
    '',
    `${meta.channel}${meta.duration ? ` · ${meta.duration}` : ''} · [watch](${meta.url})`,
    '',
    '_Transcript from the video’s own captions — timestamps are where each passage is spoken._',
    '',
    body,
    '',
  ].join('\n');
}

const YTDLP_MISSING = 'yt-dlp is not installed — fetching a video’s captions needs it. '
  + 'Install it (`pipx install yt-dlp`, or `brew install yt-dlp`) and add the video again.';

async function run(exec: ExecLike, args: string[]): Promise<{ stdout: string }> {
  try {
    return await exec('yt-dlp', args);
  } catch (e: any) {
    if (e?.code === 'ENOENT') throw new Error(YTDLP_MISSING);
    throw e;
  }
}

/**
 * Fetch a video's caption transcript, no video download.
 *
 * Manual captions are tried before auto-generated ones — when a creator wrote captions, they
 * fixed the auto-transcriber's technical-vocabulary mistakes, and technical vocabulary is the
 * part a tutor most needs right.
 */
export async function fetchVideoTranscript(
  url: string, deps: VideoIngestDeps = {},
): Promise<{ title: string; channel: string; markdown: string }> {
  const exec = deps.exec
    ?? (async (cmd: string, args: string[]) => execFileAsync(cmd, args, { timeout: 120_000 }));

  const meta = await run(exec, [
    '--skip-download', '--no-warnings', '--no-playlist',
    '--print', '%(title)s\n%(channel)s\n%(duration_string)s',
    '--', url,
  ]);
  const [title = 'Untitled video', channel = '', duration = ''] = meta.stdout.trim().split('\n');

  // yt-dlp writes the .vtt into this scratch dir; the finally removes it so a caption download
  // doesn't leak a /tmp/lwh-captions-* dir per video (covers the no-captions/empty-cues throws too).
  const dir = mkdtempSync(join(tmpdir(), 'lwh-captions-'));
  try {
    const prefix = join(dir, 'cap');
    const findVtt = () => readdirSync(dir).find((f) => f.endsWith('.vtt'));

    await run(exec, [
      '--skip-download', '--no-warnings', '--no-playlist',
      '--write-subs', '--sub-langs', 'en.*,en', '--sub-format', 'vtt',
      '-o', prefix, '--', url,
    ]);
    if (!findVtt()) {
      await run(exec, [
        '--skip-download', '--no-warnings', '--no-playlist',
        '--write-auto-subs', '--sub-langs', 'en.*,en', '--sub-format', 'vtt',
        '-o', prefix, '--', url,
      ]);
    }
    const vttFile = findVtt();
    if (!vttFile) {
      throw new Error(`"${title}" has no captions (manual or auto) — caption-less videos are not `
        + 'supported yet; Whisper transcription is deliberately parked. Pick a captioned video.');
    }

    const cues = parseVtt(readFileSync(join(dir, vttFile), 'utf8'));
    if (cues.length === 0) {
      throw new Error(`"${title}" — the caption file came back empty; nothing to ingest.`);
    }
    // The channel is returned, not just rendered into the transcript header: for THIS url YouTube
    // is the index of record for who published it, so ingestRoutes files it as the source's
    // `reported` attribution — the side a model's claim can never outrank (provenance.ts).
    return { title, channel, markdown: transcriptMarkdown({ title, channel, duration, url }, cues) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
