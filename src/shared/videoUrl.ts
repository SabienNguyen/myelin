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
