// @vitest-environment jsdom
// Blocks render their prompts as markdown and maths, like the chat beside them.
//
// This exists because of a screenshot. The chat stream had rendered `$…$` through KaTeX since the
// beginning, but every block printed its prompt with `<p>{args.question}</p>` — so in a single frame
// the tutor's prose showed real notation while the quiz question inches away showed `\frac{d}{dx}` as
// literal characters. Nothing failed, because no test looked at a block's prompt as anything but a
// string.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { BlockProse } from '../../src/client/components/BlockProse.js';

describe('BlockProse', () => {
  afterEach(cleanup);

  it('renders inline LaTeX through KaTeX rather than printing it', () => {
    const { container } = render(<BlockProse text="What is $\\frac{d}{dx}(x^2)$?" />);
    // KaTeX's own wrapper class is the observable: present means it typeset, absent means the
    // learner is being shown LaTeX source.
    expect(container.querySelectorAll('.katex').length).toBe(1);
    // The raw delimiters must not survive into the text the learner reads.
    expect(container.textContent).not.toContain('$');
  });

  it('renders display maths too', () => {
    const { container } = render(<BlockProse text="$$\\int_0^1 x\\,dx$$" />);
    expect(container.querySelectorAll('.katex').length).toBeGreaterThan(0);
  });

  it('renders ordinary markdown, so emphasis and code in a prompt read as intended', () => {
    const { container } = render(<BlockProse text="Name **all** of the halogens, not just `F`." />);
    expect(container.querySelector('strong')?.textContent).toBe('all');
    expect(container.querySelector('code')?.textContent).toBe('F');
    expect(container.textContent).not.toContain('**');
  });

  it('leaves plain prose completely alone', () => {
    render(<BlockProse text="Explain why a derivative is a limit." />);
    expect(screen.getByText('Explain why a derivative is a limit.')).toBeTruthy();
  });

  it('inline mode opens no block element, so a prompt can sit inside a sentence', () => {
    // The graded-answer summary reads "<prompt> — <answer> ✓" on one line; a <p> there would break
    // the line in half.
    const { container } = render(<BlockProse text="Two plus two?" inline />);
    expect(container.querySelector('p')).toBeNull();
    expect(container.textContent).toBe('Two plus two?');
  });

  it('does not choke on an empty prompt', () => {
    const { container } = render(<BlockProse text="" />);
    expect(container.textContent).toBe('');
  });
});
