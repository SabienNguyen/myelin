import { memo } from 'react';
import { MarkdownTextPrimitive, unstable_memoizeMarkdownComponents as memoize } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { panelBus, chatPreprocess } from '../lib/panelBus.js';
import { Mermaid } from './Mermaid.js';

export function WikiLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const m = props.href?.match(/^#\/page\/(.+)$/);
  if (!m) return <a {...props} target="_blank" rel="noreferrer" />;
  return (
    <a {...props} className="wiki-link" href={props.href}
      onClick={(e) => { e.preventDefault(); panelBus.openPage(m[1]); }} />
  );
}

/** ```mermaid fences render as diagrams (Mermaid.tsx); every other code block stays code. The
 *  language class is how react-markdown says which fence this is. */
function CodeOrDiagram(props: React.HTMLAttributes<HTMLElement> & { className?: string }) {
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
