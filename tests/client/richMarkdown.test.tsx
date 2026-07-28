// @vitest-environment jsdom
// RichMarkdown is the app's single markdown-string renderer — the page reader, source reader, and
// every block prompt delegate to it. It was extracted after a UI audit found the maths+diagram
// plugin set copied across four files; these tests lock in the four behaviours the surfaces rely
// on, so a change to the shared renderer can't silently regress any of them.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { RichMarkdown } from '../../src/client/components/RichMarkdown.js';

// Mermaid renders asynchronously through a real lib; stub it so the mermaid-fence test asserts
// routing (a fence becomes the Mermaid component) without booting the renderer.
vi.mock('../../src/client/components/Mermaid.js', () => ({
  Mermaid: ({ chart }: { chart: string }) => <div data-testid="mermaid">{chart}</div>,
}));

describe('RichMarkdown — the one markdown-string renderer', () => {
  afterEach(cleanup);

  it('typesets $…$ maths through KaTeX rather than printing the source', () => {
    // KaTeX's wrapper class is the observable — present means it typeset (it also embeds the source
    // in a hidden MathML annotation for screen readers, so textContent still contains "mc^2"; that
    // annotation is exactly why the class, not the text, is the signal).
    const { container } = render(<RichMarkdown text="mass–energy is $E = mc^2$" />);
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('does NOT run the chat path\'s \\[…\\] normaliser — that syntax is a transcript stamp label here', () => {
    // Deliberate: a video transcript's timestamp deep links render as `[\[1:05\]](url)` (escaped
    // brackets as the visible label). If this renderer ran mathDelims, the `\[1:05\]` would be eaten
    // as display math and the link would break. Model pages use $$ for display math, which typesets
    // fine; only free chat prose emits \[…\], and only the chat path normalises it.
    const { container } = render(<RichMarkdown text={'jump to [\\[1:05\\]](https://youtu.be/x?t=65s)'} />);
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://youtu.be/x?t=65s');
    expect(a?.textContent).toBe('[1:05]');
    expect(container.querySelector('.katex')).toBeNull();
  });

  it('routes a ```mermaid fence to the diagram renderer, not a code block', () => {
    const { getByTestId } = render(<RichMarkdown text={'```mermaid\ngraph LR\n A-->B\n```'} />);
    expect(getByTestId('mermaid').textContent).toContain('graph LR');
  });

  it('leaves a non-mermaid code fence as code', () => {
    const { container, queryByTestId } = render(<RichMarkdown text={'```js\nconst x = 1;\n```'} />);
    expect(queryByTestId('mermaid')).toBeNull();
    expect(container.querySelector('code')).not.toBeNull();
  });

  it('does not typeset a bare dollar amount (the loose-dollar guard)', () => {
    const { container } = render(<RichMarkdown text="it cost $12 and sold for $19" />);
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toContain('$12');
  });

  it('wikiLinks off: a #/page/ anchor is a plain link; on: it carries the wiki-link class', () => {
    const plain = render(<RichMarkdown text="see [attention](#/page/attention)" />);
    expect(plain.container.querySelector('a.wiki-link')).toBeNull();
    cleanup();
    const wiki = render(<RichMarkdown text="see [attention](#/page/attention)" wikiLinks />);
    expect(wiki.container.querySelector('a.wiki-link')).not.toBeNull();
  });

  it('inline drops the wrapping <p> so a prompt can sit inside a sentence', () => {
    const block = render(<RichMarkdown text="hello" />);
    expect(block.container.querySelector('p')).not.toBeNull();
    cleanup();
    const inline = render(<RichMarkdown text="hello" inline />);
    expect(inline.container.querySelector('p')).toBeNull();
  });
});
