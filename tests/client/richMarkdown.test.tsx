// @vitest-environment jsdom
// RichMarkdown is the app's single markdown-string renderer — the page reader, source reader, and
// every block prompt delegate to it. It was extracted after a UI audit found the maths+diagram
// plugin set copied across four files; these tests lock in the four behaviours the surfaces rely
// on, so a change to the shared renderer can't silently regress any of them.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { panelBus } from '../../src/client/lib/panelBus.js';
import { RichMarkdown } from '../../src/client/components/RichMarkdown.js';

// Mermaid renders asynchronously through a real lib; stub it so the mermaid-fence test asserts
// routing (a fence becomes the Mermaid component) without booting the renderer.
vi.mock('../../src/client/components/Mermaid.js', () => ({
  Mermaid: ({ chart }: { chart: string }) => <div data-testid="mermaid">{chart}</div>,
}));

describe('RichMarkdown — the one markdown-string renderer', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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

  it('opens a #/page/ link in the Page tab instead of switching the conversation hash', () => {
    const seen: string[] = [];
    const off = panelBus.subscribe((e) => { if (e.type === 'openPage') seen.push(e.slug); });
    const { getByRole } = render(<RichMarkdown text="see [attention](#/page/attention)" />);
    const before = location.hash;
    fireEvent.click(getByRole('link', { name: 'attention' }));
    expect(seen).toEqual(['attention']);
    expect(location.hash).toBe(before);
    off();
  });

  it('opens an external link in a new tab without an opener', () => {
    const { getByRole } = render(<RichMarkdown text="per [the source](https://example.edu/sum)" />);
    const a = getByRole('link', { name: 'the source' });
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders an unsafe, relative or conversation-hash link as text, not a link to the app', () => {
    const { container } = render(<RichMarkdown text="[a](javascript:alert(1)) [b](#/t/other) [c](/api/status)" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('a b c');
  });

  it('never fetches a foreign image; it offers a link naming the host', () => {
    const { container, getByRole } = render(
      <RichMarkdown text="![chart](https://evil.test/p.png?q=secret) ![ok](/api/uploads/fig.png)" />,
    );
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['/api/uploads/fig.png']);
    const link = getByRole('link', { name: /image from evil\.test/ });
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('an unlabeled [[slug]] link resolves to the page title from the graph; a labeled one keeps its label', async () => {
    // wikiPreprocess turns `[[qkv-attention]]` into `[qkv-attention](#/page/qkv-attention)` — the
    // visible text IS the slug because the tutor wrote no label. `[[qkv-attention|the basics]]`
    // becomes `[the basics](#/page/qkv-attention)`, a real label that must survive untouched.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ nodes: [{ slug: 'qkv-attention', title: 'QKV attention' }] }),
    })));
    // A fresh module graph: usePageTitle's cache (in pageTitles.ts, imported transitively via
    // MarkdownText.js) is throttled to one /api/graph call per 15s across every caller in the
    // process, including other test files Vitest happens to run alongside this one. Reimporting
    // after vi.resetModules() gives this test its own cold cache instead of betting on suite-wide
    // execution order. vi.mock('.../Mermaid.js') above still applies — mock registrations survive
    // resetModules, only instantiated modules are dropped.
    vi.resetModules();
    const { RichMarkdown: FreshRichMarkdown } = await import('../../src/client/components/RichMarkdown.js');
    render(
      <FreshRichMarkdown
        text="see [qkv-attention](#/page/qkv-attention) and [the basics](#/page/qkv-attention)"
      />,
    );
    // Async: the title only exists once usePageTitle's graph fetch resolves.
    const resolved = await screen.findByRole('link', { name: 'QKV attention' });
    const labeled = screen.getByRole('link', { name: 'the basics' });
    expect(resolved.getAttribute('href')).toBe('#/page/qkv-attention');
    expect(labeled.getAttribute('href')).toBe('#/page/qkv-attention');
    expect(screen.getAllByRole('link', { name: /QKV attention|the basics/ })).toHaveLength(2);
  });

  it('scrubs a leaked ChatML control token — text here is model output (a block prompt or a compiled page)', () => {
    // A degenerate local model can leak `<|im_start|>assistant` verbatim into a block prompt or a
    // page the compile role wrote; MarkdownText's chatPreprocess already scrubs the same class of
    // artifact from chat turns, and this is the other surface that renders raw model text.
    const { container } = render(<RichMarkdown text={'ready?<|im_start|>assistant\nyes.'} />);
    expect(container.textContent).not.toContain('<|im_start|>');
    expect(container.textContent).toContain('ready?');
    expect(container.textContent).toContain('yes.');
  });

  it('inline drops the wrapping <p> so a prompt can sit inside a sentence', () => {
    const block = render(<RichMarkdown text="hello" />);
    expect(block.container.querySelector('p')).not.toBeNull();
    cleanup();
    const inline = render(<RichMarkdown text="hello" inline />);
    expect(inline.container.querySelector('p')).toBeNull();
  });
});
