// Shared between AddMaterial (routing a pasted URL to the right ingest endpoint) and the server's
// video ingest (guarding the same door) — one definition so the client never promises a URL shape
// the server then refuses.
//
// Conservative on purpose: YouTube's URL shapes only. yt-dlp supports hundreds of sites, but a
// broad "looks like video" guess would misroute ordinary article URLs away from the working
// download path; other hosts can be added when someone actually brings one.
const YOUTUBE_PATTERNS = [
  /^https?:\/\/(www\.|m\.)?youtube\.com\/watch\?/i,
  /^https?:\/\/(www\.|m\.)?youtube\.com\/shorts\//i,
  /^https?:\/\/(www\.|m\.)?youtube\.com\/live\//i,
  /^https?:\/\/(www\.|m\.)?youtube\.com\/embed\//i,
  /^https?:\/\/youtu\.be\//i,
];

export function isVideoUrl(url: string): boolean {
  return YOUTUBE_PATTERNS.some((p) => p.test(url.trim()));
}

/** The 11-char YouTube video id, from any of the URL shapes above — or null when there isn't one
 *  (the embed player needs the id; a URL we can't parse still works as a plain link). */
export function videoId(url: string): string | null {
  const trimmed = url.trim();
  const m = /[?&]v=([\w-]{11})/.exec(trimmed)
    ?? /youtu\.be\/([\w-]{11})/.exec(trimmed)
    ?? /youtube\.com\/(?:shorts|live|embed)\/([\w-]{11})/.exec(trimmed);
  return m ? m[1] : null;
}

/** The video URL with a start-time parameter — YouTube honors ?t=/&t= seconds on watch, youtu.be
 *  and shorts URLs alike. (Mirrored by the server's transcript linkifier, which imports this.) */
export function atTime(url: string, seconds: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(seconds)}s`;
}

/** Seconds as the M:SS / H:MM:SS a human reads — the label beside a deep link or snippet range. */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
