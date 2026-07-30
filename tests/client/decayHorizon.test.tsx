// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const { DecayHorizon } = await import('../../src/client/components/DecayHorizon.js');
const { panelBus } = await import('../../src/client/lib/panelBus.js');

const stubHorizon = (pages: unknown[]) => {
  const spy = vi.fn(async (url: string) => {
    if (url === '/api/horizon') return { ok: true, json: async () => ({ pages }) } as any;
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
};

// In the API's order: slipped first, then ascending daysLeft — the component must keep it.
const PAGES = [
  { slug: 'buffers', title: 'Buffers', level: 'practicing', daysLeft: null, slipped: true },
  { slug: 'streams', title: 'Streams', level: 'mastered', daysLeft: 9, slipped: false },
  { slug: 'sockets', title: 'Sockets', level: 'practicing', daysLeft: 45, slipped: false },
];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('DecayHorizon', () => {
  it('positions each tick at daysLeft/45 along the rail, slipped pages at the now edge', async () => {
    stubHorizon(PAGES);
    render(<DecayHorizon />);
    const due = await screen.findByRole('button', { name: 'Buffers — due now' });
    expect(due.style.left).toBe('0%');
    expect(due.title).toBe('Buffers — due now');
    expect(due.className).toContain('horizon-tick--slipped');
    const streams = screen.getByRole('button', { name: 'Streams — slips in 9 days' });
    expect(streams.style.left).toBe('20%');
    expect(streams.title).toBe('Streams — slips in 9 days');
    expect(streams.className).not.toContain('horizon-tick--slipped');
    const sockets = screen.getByRole('button', { name: 'Sockets — slips in 45 days' });
    expect(sockets.style.left).toBe('100%');
  });

  it('colours ticks by mastery level through the --mastery-* tokens', async () => {
    stubHorizon(PAGES);
    render(<DecayHorizon />);
    const streams = await screen.findByRole('button', { name: 'Streams — slips in 9 days' });
    expect(streams.style.getPropertyValue('--tick')).toBe('var(--mastery-mastered, var(--mastery-unseen))');
  });

  it('keeps the API sort as DOM order so keyboard traversal goes most-urgent-first', async () => {
    stubHorizon(PAGES);
    render(<DecayHorizon />);
    await screen.findByRole('button', { name: 'Buffers — due now' });
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Buffers — due now', 'Streams — slips in 9 days', 'Sockets — slips in 45 days']);
  });

  it('clamps a daysLeft beyond the window to the right edge, and uses the singular for one day', async () => {
    stubHorizon([
      { slug: 'a', title: 'Alpha', level: 'mastered', daysLeft: 60, slipped: false },
      { slug: 'b', title: 'Beta', level: 'exposed', daysLeft: 1, slipped: false },
    ]);
    render(<DecayHorizon />);
    const alpha = await screen.findByRole('button', { name: 'Alpha — slips in 60 days' });
    expect(alpha.style.left).toBe('100%');
    expect(screen.getByRole('button', { name: 'Beta — slips in 1 day' })).toBeTruthy();
  });

  it('opens the page through panelBus when a tick is clicked', async () => {
    stubHorizon(PAGES);
    const events: any[] = [];
    const unsubscribe = panelBus.subscribe((e) => events.push(e));
    try {
      render(<DecayHorizon />);
      fireEvent.click(await screen.findByRole('button', { name: 'Streams — slips in 9 days' }));
      expect(events).toEqual([{ type: 'openPage', slug: 'streams' }]);
    } finally {
      unsubscribe();
    }
  });

  it('renders nothing with fewer than two clocked pages — an unslipped null daysLeft is not a tick', async () => {
    const spy = stubHorizon([
      { slug: 'streams', title: 'Streams', level: 'mastered', daysLeft: 9, slipped: false },
      { slug: 'ideas', title: 'Ideas', level: 'exposed', daysLeft: null, slipped: false },
    ]);
    const { container } = render(<DecayHorizon />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not fetch while hidden', async () => {
    const spy = stubHorizon(PAGES);
    render(<DecayHorizon visible={false} />);
    expect(spy).not.toHaveBeenCalled();
  });
});
