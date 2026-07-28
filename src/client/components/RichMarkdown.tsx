import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { escapeLooseDollars } from '../lib/panelBus.js';
import { WikiLink, CodeOrDiagram } from './MarkdownText.js';

/**
 * The one way this app renders a markdown STRING: GitHub-flavoured markdown, `$…$` maths through
 * KaTeX, ```mermaid fences as diagrams, and the loose-dollar guard so real prices ("$12,000") don't
 * typeset. Every surface that shows prose from a string — the page reader, the source reader, a
 * block's prompt — was repeating this exact plugin set; a UI audit that added maths and diagrams to
 * the readers left the config copied four ways. This is the single source of truth for the three.
 *
 * Deliberately NOT mathDelims (the chat path's \(…\)/\[…\] → $-delimiter normaliser): the content
 * here uses `\[…\]` for its OWN purpose — a video transcript's timestamp deep links are emitted as
 * `[\[1:05\]](url)`, escaped brackets as the visible label — so running mathDelims would eat the
 * `\[1:05\]` as display math and break the link (a regression the transcriptStamp tests catch).
 * Model-written pages and converted papers use `$…$`/`$$…$$`, which this already typesets; the
 * chat path owns \(…\) because only free chat prose emits them.
 *
 * (MarkdownText stays separate: it renders the assistant-ui message part it is mounted inside, not
 * an arbitrary string, so it can't share this component — but it shares the same WikiLink and
 * CodeOrDiagram, so the two still agree on what `$…$` and a mermaid fence mean.)
 *
 * `wikiLinks` turns `#/page/slug` anchors into in-app page opens (the vault's own pages link to each
 * other; an external source does not). `inline` drops the wrapping `<p>` for a prompt spliced into a
 * sentence.
 */
export function RichMarkdown(
  { text, wikiLinks = false, inline = false }: { text: string; wikiLinks?: boolean; inline?: boolean },
) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        code: CodeOrDiagram,
        ...(wikiLinks ? { a: WikiLink } : {}),
        // A prompt spliced into a sentence must not open a block element mid-line.
        ...(inline ? { p: ({ children }: { children?: React.ReactNode }) => <>{children}</> } : {}),
      }}
    >
      {escapeLooseDollars(text)}
    </Markdown>
  );
}
