import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Shared by the JSON-url ingest route (ingestRoutes.ts) and the ingest_paper tutor tool
 * (ingestTools.ts) — one place to change timeout/size/content-type policy for URL downloads. */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/epub+zip': '.epub',
};

/** arXiv nicety: /abs/<id> is the HTML landing page; /pdf/<id> serves the actual PDF. Pure —
 * no I/O — so it's independently unit-testable without a network fixture. */
export function rewriteArxivUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/(^|\.)arxiv\.org$/i.test(u.hostname) && u.pathname.startsWith('/abs/')) {
      u.pathname = u.pathname.replace(/^\/abs\//, '/pdf/');
      return u.toString();
    }
  } catch {
    // not a valid absolute URL — let the caller's fetch surface the real error
  }
  return url;
}

function extFromUrl(url: string): string | null {
  const m = new URL(url).pathname.match(/\.(pdf|epub|docx)$/i);
  return m ? `.${m[1].toLowerCase()}` : null;
}

export interface DownloadedFile { path: string; contentType: string }

/**
 * Downloads a URL to a temp file for ingestion. Follows redirects, times out at 60s, caps at
 * 50MB, rewrites arxiv.org/abs/ links to /pdf/, and infers the file extension from the response
 * content-type (falling back to the URL path). Always throws a descriptive Error on failure —
 * callers (the JSON-url ingest route, the ingest_paper tool) turn that into a structured 400/error
 * response, never a stack trace reaching the caller.
 */
export async function downloadToTemp(
  url: string, opts: { fetchImpl?: typeof fetch } = {},
): Promise<DownloadedFile> {
  const doFetch = opts.fetchImpl ?? fetch;
  const target = rewriteArxivUrl(url);

  const res = await doFetch(target, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${target}`);

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = EXT_BY_CONTENT_TYPE[contentType] ?? extFromUrl(target);
  if (!ext) throw new Error(`unsupported content-type "${contentType || 'unknown'}" for download from ${target}`);

  const declaredLen = Number(res.headers.get('content-length') ?? 0);
  if (declaredLen > MAX_DOWNLOAD_BYTES) throw new Error(`download exceeds ${MAX_DOWNLOAD_BYTES} byte cap`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`download exceeds ${MAX_DOWNLOAD_BYTES} byte cap`);

  const dir = mkdtempSync(join(tmpdir(), 'lwh-download-'));
  const path = join(dir, `download${ext}`);
  writeFileSync(path, buf);
  return { path, contentType };
}
