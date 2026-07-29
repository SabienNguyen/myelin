// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const { WatchVideo } = await import('../../src/client/components/blocks/WatchVideo.js');

const args = {
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  startSeconds: 225,
  endSeconds: 300,
  title: 'The Quadratic Formula — derived',
  why: 'Watch how completing the square becomes the formula.',
  pageSlug: 'quadratic-formula',
};

afterEach(cleanup);

describe('WatchVideo', () => {
  it('embeds the snippet: player src carries the id, start and end', () => {
    render(<WatchVideo args={args} result={undefined} addResult={() => {}} />);
    const frame = screen.getByTitle('The Quadratic Formula — derived') as HTMLIFrameElement;
    expect(frame.src).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(frame.src).toContain('start=225');
    expect(frame.src).toContain('end=300');
    // The fallback deep link starts at the same second the player does.
    const link = screen.getByRole('link', { name: 'open on YouTube' }) as HTMLAnchorElement;
    expect(link.href).toContain('t=225s');
  });

  it('done watching submits { watched: true } — the only producer of that result', () => {
    const results: any[] = [];
    render(<WatchVideo args={args} result={undefined} addResult={(r) => results.push(r)} />);
    fireEvent.click(screen.getByRole('button', { name: 'done watching' }));
    expect(results).toEqual([{ watched: true }]);
  });

  it('a URL without a parseable id gets a plain link, no dead player frame', () => {
    render(<WatchVideo args={{ ...args, url: 'https://vimeo.com/12345' }} result={undefined} addResult={() => {}} />);
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('link')).toBeTruthy();
  });

  it('the done card says watched, links the snippet, and is honest about what it counts for', () => {
    render(<WatchVideo args={args} result={{ watched: true, grading: { verdict: 'reviewed' } }} addResult={() => {}} />);
    expect(screen.getByText(/graded/)).toBeTruthy();
    expect(screen.getByText(/Watched/)).toBeTruthy();
    expect(screen.getByText(/the next check is what proves it stuck/)).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull(); // the player leaves with the assignment
  });
});
