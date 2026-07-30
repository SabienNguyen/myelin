// YouTube search for the tutor's find_video tool — yt-dlp's ytsearch, no API key, no scraping of
// our own. The same install-on-demand binary videoIngest.ts already depends on for captions, so a
// machine that can ingest a video can search for one, and a machine that can't gets the same
// actionable install message from both doors.
//
// --flat-playlist keeps this to ONE metadata request for the whole result page (no per-video
// probe), which is what makes a 5-hit search fast enough to sit inside a tutor turn.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VideoSearchDeps {
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
}

export interface VideoHit {
  title: string;
  url: string;
  channel?: string;
  /** Duration in seconds — the tutor should prefer a 6-minute explanation over a 3-hour lecture
   *  unless the learner asked for depth. */
  durationSeconds?: number;
  views?: number;
}

const YTDLP_MISSING = 'yt-dlp is not installed — searching videos needs it. '
  + 'Install it (`pipx install yt-dlp`, or `brew install yt-dlp`) and try again.';

/** Parse `--dump-single-json --flat-playlist` output into hits. Exported for direct unit testing.
 *  Flat entries carry `url` (sometimes just an id, depending on yt-dlp's version) — normalize to a
 *  full watch URL so every downstream consumer (watch_video, ingest, transcripts) gets one shape. */
export function parseSearchJson(stdout: string): VideoHit[] {
  const parsed = JSON.parse(stdout);
  const entries: any[] = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return entries
    .filter((e) => e && (e.id || e.url))
    .map((e) => {
      const id = typeof e.id === 'string' ? e.id : undefined;
      const raw = typeof e.url === 'string' ? e.url : '';
      const url = /^https?:\/\//.test(raw) ? raw : `https://www.youtube.com/watch?v=${id ?? raw}`;
      return {
        title: String(e.title ?? url),
        url,
        ...(e.channel || e.uploader ? { channel: String(e.channel ?? e.uploader) } : {}),
        ...(typeof e.duration === 'number' ? { durationSeconds: Math.round(e.duration) } : {}),
        ...(typeof e.view_count === 'number' ? { views: e.view_count } : {}),
      };
    });
}

export async function searchVideos(
  query: string, limit = 5, deps: VideoSearchDeps = {},
): Promise<VideoHit[]> {
  const exec = deps.exec
    ?? (async (cmd: string, args: string[]) => execFileAsync(cmd, args, { timeout: 60_000 }));
  const n = Math.max(1, Math.min(10, Math.floor(limit)));
  let stdout: string;
  try {
    ({ stdout } = await exec('yt-dlp', [
      '--dump-single-json', '--flat-playlist', '--no-warnings',
      '--', `ytsearch${n}:${query}`,
    ]));
  } catch (e: any) {
    if (e?.code === 'ENOENT') throw new Error(YTDLP_MISSING);
    throw e;
  }
  return parseSearchJson(stdout);
}
