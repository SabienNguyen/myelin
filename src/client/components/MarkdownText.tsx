import { memo } from 'react';
import { MarkdownTextPrimitive, unstable_memoizeMarkdownComponents as memoize } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { panelBus, chatPreprocess } from '../lib/panelBus.js';
import { Mermaid } from './Mermaid.js';

// A vault slug as wikiPreprocess writes it into `#/page/<slug>`. Anything else under #/ would be
// read by urlState as a conversation hash and switch the learner to another thread.
const PAGE_HREF = /^#\/page\/([A-Za-z0-9][\w.-]*)$/;

/**
 * The one link policy for model-written markdown (chat, asides, block prompts, pages, sources).
 * `#/page/<slug>` opens the page in the Page tab; http(s) and mailto open in a new tab so a
 * citation never replaces the app; anything else — an href react-markdown emptied as unsafe
 * (`javascript:`), a relative path, another hash — renders as text. An `<a href="">` there used to
 * open a second copy of Myelin, and a bare `#/…` hash switched conversations.
 */
export function MarkdownLink({ href, children, node: _node, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const page = href?.match(PAGE_HREF);
  if (page) {
    return (
      <a {...rest} className="wiki-link" href={href}
        onClick={(e) => { e.preventDefault(); panelBus.openPage(page[1]); }}>{children}</a>
    );
  }
  let url: URL | null = null;
  try { url = href ? new URL(href) : null; } catch { url = null; }
  if (url && (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:')) {
    return <a {...rest} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  }
  return <span>{children}</span>;
}

/**
 * Images in model output load only from this origin or inline data. An injected page read through
 * read_url could have the tutor write `![](https://host/?q=<learner data>)`, which the browser
 * fetched the moment the message rendered. A foreign image becomes a link the learner can choose
 * to open; the server's `img-src 'self' data: blob:` CSP (staticRoutes.ts) backs this up.
 */
export function MarkdownImage({ src, alt, node: _node, ...rest }: React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) {
  let url: URL | null = null;
  try { url = typeof src === 'string' && src ? new URL(src, location.href) : null; } catch { url = null; }
  if (!url) return alt ? <span>{alt}</span> : null;
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === location.origin) {
    return <img {...rest} src={src as string} alt={alt ?? ''} />;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return alt ? <span>{alt}</span> : null;
  return (
    <a className="md-image-foreign" href={url.href} target="_blank" rel="noopener noreferrer">
      image from {url.host}{alt ? ` (${alt})` : ''} · open
    </a>
  );
}

/** ```mermaid fences render as diagrams (Mermaid.tsx); every other code block stays code. The
 *  language class is how react-markdown says which fence this is. Exported so the Page reader
 *  (PagePanel) renders a page's diagrams the same way the chat does. */
export function CodeOrDiagram(props: React.HTMLAttributes<HTMLElement> & { className?: string }) {
  const source = typeof props.children === 'string' ? props.children
    : Array.isArray(props.children) ? props.children.join('') : '';
  if (props.className?.includes('language-mermaid')) return <Mermaid chart={source} />;
  return <code {...props} />;
}

const components = memoize({ a: MarkdownLink, img: MarkdownImage, code: CodeOrDiagram });
export const MarkdownText = memo(() => (
  <MarkdownTextPrimitive remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}
    components={components} preprocess={chatPreprocess} defer />
));
