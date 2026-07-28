import { memo } from 'react';
import { RichMarkdown } from './RichMarkdown.js';

/**
 * Markdown and maths for a block's own prompt text.
 *
 * The chat stream has rendered `$…$` through KaTeX since the beginning (MarkdownText.tsx), but every
 * block rendered its prompt as a raw string — `<p>{args.question}</p>`. So the tutor's chat prose
 * showed real notation while the question it was asking about showed `\frac{d}{dx}x^2` as literal
 * characters, in the same screenshot, inches apart. A learner reading a physics or maths question
 * cannot be asked to parse LaTeX source.
 *
 * A thin wrapper over RichMarkdown — the app's one markdown-string renderer — so a block prompt
 * agrees with the page reader and the source reader on maths and diagrams. `inline` renders without
 * the wrapping `<p>` for the places a prompt sits inside a sentence (a graded-answer summary line).
 */
export const BlockProse = memo(function BlockProse(
  { text, inline = false }: { text: string; inline?: boolean },
) {
  return <RichMarkdown text={text} inline={inline} />;
});
