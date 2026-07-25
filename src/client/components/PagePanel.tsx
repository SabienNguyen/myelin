import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getPage } from '../lib/api.js';
import { WikiLink } from './MarkdownText.js';
import { wikiPreprocess } from '../lib/panelBus.js';

export function PagePanel({ slug }: { slug: string | null }) {
  const [page, setPage] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  // The un-caught version left the panel on "Loading…" forever whenever the fetch rejected (backend
  // down, proxy 502, non-JSON body) — indistinguishable from a slow load. Reset both on slug change
  // so switching pages after a failure retries instead of showing the stale error.
  useEffect(() => {
    if (!slug) return;
    setPage(null);
    setError(null);
    getPage(slug)
      .then(setPage)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [slug]);
  if (!slug) return <p className="empty">Click a wiki-link or graph node.</p>;
  if (error) return <p className="empty" role="status">Could not load “{slug}” — {error}</p>;
  if (!page) return <p className="empty">Loading…</p>;
  return (
    <article className="page-panel">
      <h2>{page.page.meta.title}</h2>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: WikiLink }}>
        {wikiPreprocess(page.page.body)}
      </ReactMarkdown>
    </article>
  );
}
