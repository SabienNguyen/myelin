import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { escapeLooseDollars } from '../lib/panelBus.js';

/**
 * Markdown and maths for a block's own prompt text.
 *
 * The chat stream has rendered `$…$` through KaTeX since the beginning (MarkdownText.tsx), but every
 * block rendered its prompt as a raw string — `<p>{args.question}</p>`. So the tutor's chat prose
 * showed real notation while the question it was asking about showed `\frac{d}{dx}x^2` as literal
 * characters, in the same screenshot, inches apart. A learner reading a physics or maths question
 * cannot be asked to parse LaTeX source.
 *
 * Deliberately NOT `MarkdownText`: that component renders the assistant-ui message part it is
 * mounted inside, so it cannot be pointed at an arbitrary string. Same plugin set, so the two agree
 * on what `$…$` means.
 *
 * `inline` renders without the wrapping `<p>` — for the places a prompt sits inside a sentence (a
 * graded-answer summary line, say) rather than as its own paragraph.
 */
export const BlockProse = memo(function BlockProse(
  { text, inline = false }: { text: string; inline?: boolean },
) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={inline
        // A prompt spliced into a sentence must not open a block element mid-line.
        ? { p: ({ children }) => <>{children}</> }
        : undefined}
    >
      {/* Course-bank problems are drilled VERBATIM, and real exam text says things like "bought
          for $12,000 is sold for $19,500" — which remark-math would typeset as one math span.
          The same guard runs in chatPreprocess, so chat and block still agree on what $…$ means. */}
      {escapeLooseDollars(text)}
    </Markdown>
  );
});
