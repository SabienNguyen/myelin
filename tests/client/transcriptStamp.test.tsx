// @vitest-environment jsdom
// The transcript's timestamp deep links ride markdown through the same pipeline the reader and
// page panel use. The syntax is deliberately fussy — a bold link whose TEXT contains literal
// brackets (**[\[1:05\]](url&t=65s)**) — so this pins that it renders as a clickable [1:05],
// not as bracket soup or a swallowed link.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BlockProse } from '../../src/client/components/BlockProse.js';
import { atTime, transcriptMarkdown, parseVtt } from '../../src/server/videoIngest.js';

afterEach(cleanup);

describe('transcript timestamp deep links', () => {
  it('renders a stamp as a link whose visible text is the bracketed time', () => {
    render(<BlockProse text={'**[\\[1:05\\]](https://youtu.be/abc?t=65s)** we start with the area of a circle'} />);
    const a = screen.getByText('[1:05]').closest('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('https://youtu.be/abc?t=65s');
  });

  it('the generated transcript renders every block stamp as such a link', () => {
    const vtt = 'WEBVTT\n\n00:00:05.000 --> 00:00:08.000\nhello there\n';
    const md = transcriptMarkdown(
      { title: 'T', channel: 'C', duration: '1:00', url: 'https://youtu.be/x' },
      parseVtt(vtt),
    );
    render(<BlockProse text={md} />);
    const a = screen.getByText('[0:05]').closest('a');
    expect(a!.getAttribute('href')).toBe(atTime('https://youtu.be/x', 5));
  });
});
