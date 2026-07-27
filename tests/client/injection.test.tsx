// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BlockProse } from '../../src/client/components/BlockProse.js';

afterEach(cleanup);

// The tutor's prose and every block prompt pass through react-markdown, and vault pages come from
// INGESTED material — a hostile PDF or web page ends up rendered in this app. These tests pin the
// two properties the whole rendering surface leans on: raw HTML is escaped to text (no rehype-raw
// anywhere, by design), and non-http link protocols are defanged by react-markdown's default url
// transform. They exist so that someone adding rehype-raw or a custom urlTransform for a feature
// finds out what they just traded away.
describe('markdown rendering is inert against injected content', () => {
  it('renders a script tag as text, not as an element', () => {
    render(<BlockProse text={'before <script>window.pwned = true;</script> after'} />);
    expect(document.querySelector('script')).toBeNull();
    expect((window as any).pwned).toBeUndefined();
  });

  it('renders an img with an onerror handler as text, not as an element', () => {
    render(<BlockProse text={'<img src=x onerror="window.pwned=true"> caption'} />);
    expect(document.querySelector('img')).toBeNull();
  });

  it('defangs javascript: hrefs in markdown links', () => {
    render(<BlockProse text={'[click me](javascript:window.pwned=true)'} />);
    const a = screen.getByText('click me').closest('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
  });

  it('keeps ordinary https links working', () => {
    render(<BlockProse text={'[a real link](https://example.com/page)'} />);
    expect(screen.getByText('a real link').closest('a')!.getAttribute('href'))
      .toBe('https://example.com/page');
  });

  it('renders hostile text inside inline math without executing anything', () => {
    // KaTeX escapes its input (no trust option is passed anywhere in this repo).
    render(<BlockProse text={'$x = \\text{<script>window.pwned=true</script>}$'} />);
    expect(document.querySelector('script')).toBeNull();
    expect((window as any).pwned).toBeUndefined();
  });
});
