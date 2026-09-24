import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { escapeLooseDollars, scrubModelArtifacts } from '../lib/panelBus.js';
import { MarkdownLink, MarkdownImage, CodeOrDiagram } from './MarkdownText.js';

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
 * an arbitrary string, so it can't share this component — but it shares the same link, image and
 * CodeOrDiagram components, so the two agree on what `$…$`, a mermaid fence, a link and an image
 * mean. See MarkdownLink and MarkdownImage for that policy.)
 *
 * `inline` drops the wrapping `<p>` for a prompt spliced into a sentence.
 *
 * `text` is model output whenever this renders a block prompt (BlockProse) or a page the compile
 * role wrote — the same untrusted-text status MarkdownText's `chatPreprocess` treats a chat turn as.
 * A degenerate local model can leak raw ChatML control tokens (`<|im_start|>assistant`) into either
 * path, so `scrubModelArtifacts` runs first, same as chatPreprocess does, before the loose-dollar
 * guard judges what's left.
 */
export function RichMarkdown(
  { text, inline = false }: { text: string; inline?: boolean },
) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        code: CodeOrDiagram,
        a: MarkdownLink,
        img: MarkdownImage,
        // A prompt spliced into a sentence must not open a block element mid-line.
        ...(inline ? { p: ({ children }: { children?: React.ReactNode }) => <>{children}</> } : {}),
      }}
    >
      {escapeLooseDollars(scrubModelArtifacts(text))}
    </Markdown>
  );
}
