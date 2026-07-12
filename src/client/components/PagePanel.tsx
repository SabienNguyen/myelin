import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getPage } from '../lib/api.js';
import { WikiLink } from './MarkdownText.js';
import { wikiPreprocess } from '../lib/panelBus.js';

export function PagePanel({ slug }: { slug: string | null }) {
  const [page, setPage] = useState<any>(null);
  useEffect(() => { if (slug) getPage(slug).then(setPage); }, [slug]);
  if (!slug) return <p className="empty">Click a wiki-link or graph node.</p>;
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
