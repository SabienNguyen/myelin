import { memo } from 'react';
import { MarkdownTextPrimitive, unstable_memoizeMarkdownComponents as memoize } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import { panelBus, wikiPreprocess } from '../lib/panelBus.js';

export function WikiLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const m = props.href?.match(/^#\/page\/(.+)$/);
  if (!m) return <a {...props} target="_blank" rel="noreferrer" />;
  return (
    <a {...props} className="wiki-link" href={props.href}
      onClick={(e) => { e.preventDefault(); panelBus.openPage(m[1]); }} />
  );
}

const components = memoize({ a: WikiLink });
export const MarkdownText = memo(() => (
  <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} components={components}
    preprocess={wikiPreprocess} defer />
));
