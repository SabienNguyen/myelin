import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { htmlToText, htmlTitle } from './htmlText.js';

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

export interface DownloadedFile {
  path: string;
  contentType: string;
  /** The document's own title, when the source reports one (currently HTML's <title>). Lets the
   *  ingest route name the book after the article instead of after its URL. */
  title?: string;
}

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

  // An ordinary web page is a first-class source. It used to be the one thing "Add material"
  // refused outright — a learner could paste a PDF, an ePub, a repo or a YouTube link, but the
  // documentation page or article a subject actually lives on came back "unsupported
  // content-type text/html". The tutor could already READ that page (read_url) and cite it; it
  // simply could not be KEPT. Extracting to markdown here puts it through the ordinary
  // conversion pipeline, so a saved article behaves like every other source from this point on.
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    const html = await res.text();
    if (html.length > MAX_DOWNLOAD_BYTES) throw new Error(`download exceeds ${MAX_DOWNLOAD_BYTES} byte cap`);
    const text = htmlToText(html);
    if (!text) throw new Error(`no readable text found at ${target}`);
    const title = htmlTitle(html);
    const dir = mkdtempSync(join(tmpdir(), 'lwh-dl-'));
    const path = join(dir, 'page.md');
    // The title becomes the document's H1 so the compiled book is named after the article rather
    // than after a URL slug, and the source URL is recorded in the text itself — a page the
    // learner reads later should say where it came from without a round-trip to the ledger.
    writeFileSync(path, `# ${title ?? target}\n\nSource: ${target}\n\n${text}\n`);
    return { path, contentType, title: title ?? undefined };
  }

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
