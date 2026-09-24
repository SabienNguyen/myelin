import { memo } from 'react';
import { MarkdownTextPrimitive, unstable_memoizeMarkdownComponents as memoize } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { panelBus, chatPreprocess } from '../lib/panelBus.js';
import { usePageTitle, usePageSlugForTitle } from '../lib/pageTitles.js';
import { Mermaid } from './Mermaid.js';

/** A citation title reaches here percent-encoded (citationLinks, panelBus.ts); a hand-typed or
 *  otherwise garbled href with an invalid escape must render as something rather than crash the
 *  whole message — same tolerance urlState.ts applies to a malformed page-slug hash. */
function decodeCiteTitle(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export function WikiLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const m = props.href?.match(/^#\/page\/(.+)$/);
  const slug = m ? m[1] : null;
  const citeMatch = props.href?.match(/^#\/cite\/(.+)$/);
  const citeTitle = citeMatch ? decodeCiteTitle(citeMatch[1]) : null;
  // wikiPreprocess (panelBus.ts) emits `[label || slug](#/page/slug)` — the tutor rarely writes a
  // label, so an unlabeled link's visible text IS the raw slug. react-markdown sometimes wraps a
  // lone text child in a one-element array rather than handing it over bare, so both shapes count.
  const child = Array.isArray(props.children) && props.children.length === 1 ? props.children[0] : props.children;
  const unlabeled = slug !== null && typeof child === 'string' && child === slug;
  // Both hooks are called on every render, before either branch below returns — a conditional
  // hook call would break React's same-hooks-every-render rule the moment a chat message mixes
  // wiki links, citation chips, and an ordinary external link.
  const title = usePageTitle(unlabeled ? slug : null);
  const citeSlug = usePageSlugForTitle(citeTitle);
  if (citeTitle !== null) {
    // citationLinks only ever emits this href for a "Vault: <title>" ref — an opaque web-search
    // ref is dropped before it becomes a link — so resolving is purely "do we have this page
    // cached yet", not "does this citation deserve a link at all".
    const label = `source: ${citeTitle}`;
    if (citeSlug) {
      return (
        <a className="cite-chip" href={`#/page/${citeSlug}`} title={citeTitle} aria-label={label}
          onClick={(e) => { e.preventDefault(); panelBus.openPage(citeSlug); }}>
          {citeTitle}
        </a>
      );
    }
    return <span className="cite-chip" title={citeTitle} aria-label={label}>{citeTitle}</span>;
  }
  if (!slug) return <a {...props} target="_blank" rel="noreferrer" />;
  return (
    <a {...props} className="wiki-link" href={props.href}
      onClick={(e) => { e.preventDefault(); panelBus.openPage(slug); }}>
      {unlabeled && title ? title : props.children}
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

const components = memoize({ a: WikiLink, code: CodeOrDiagram });
export const MarkdownText = memo(() => (
  <MarkdownTextPrimitive remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}
    components={components} preprocess={chatPreprocess} defer />
));
