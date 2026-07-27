// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const { PagePanel } = await import('../../src/client/components/PagePanel.js');

const payload = (misconceptions: string[]) => ({
  page: { slug: 'stream-consumer', meta: { title: 'Stream consumer', status: 'solid' }, body: 'body text' },
  edges: {}, neighbors: {}, routes: [], noLadder: false,
  standing: {
    level: 'practicing', effective: 'practicing', lastReinforced: '2026-07-27',
    applied: 1, explained: 0, rubric: 0, struggled: 0, restsOnRubric: false, misconceptions,
  },
});

const stubPage = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  if (url === '/api/page/stream-consumer') return { ok: true, json: async () => body } as any;
  throw new Error(`unexpected fetch: ${url}`);
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// T43: the page panel is the ONE surface where a learner can read their own recorded
// misconception in full — the graph carries it only in an aria-label/tooltip and the session
// plan only as a truncated chip — so the list must say what it is, not render bare red bullets.
describe('PagePanel standing misconceptions', () => {
  it('names the list and shows the misconception text', async () => {
    stubPage(payload(['believes a larger buffer fixes split multi-byte characters']));
    render(<PagePanel slug="stream-consumer" />);
    expect(await screen.findByText(/recorded misconception — the tutor will re-test it/)).toBeTruthy();
    expect(screen.getByText('believes a larger buffer fixes split multi-byte characters')).toBeTruthy();
  });

  it('pluralizes when several are recorded', async () => {
    stubPage(payload(['confuses buffer size with decoder state', 'thinks chunks align to characters']));
    render(<PagePanel slug="stream-consumer" />);
    expect(await screen.findByText(/recorded misconceptions — the tutor will re-test them/)).toBeTruthy();
  });

  it('renders no misconception label when none are recorded', async () => {
    stubPage(payload([]));
    render(<PagePanel slug="stream-consumer" />);
    await screen.findByText('Stream consumer');
    expect(screen.queryByText(/recorded misconception/)).toBeNull();
  });

  // The panel used to fetch once per slug, so a misconception repaired in the thread stayed on
  // screen — accusing the learner — for as long as the panel was open. It now polls on the
  // graph's cadence while visible.
  it('a poll clears a misconception resolved while the panel is open', async () => {
    vi.useFakeTimers();
    try {
      const bodies = [
        payload(['believes a larger buffer fixes split multi-byte characters']),
        payload([]),
      ];
      let callCount = 0;
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true, json: async () => bodies[Math.min(bodies.length - 1, callCount++)],
      }) as any));
      render(<PagePanel slug="stream-consumer" visible />);
      await vi.waitFor(() => { expect(screen.queryByText(/recorded misconception/)).toBeTruthy(); });
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.waitFor(() => { expect(screen.queryByText(/recorded misconception/)).toBeNull(); });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll while hidden', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => payload([]) } as any));
    vi.stubGlobal('fetch', fetchSpy);
    vi.useFakeTimers();
    try {
      render(<PagePanel slug="stream-consumer" visible={false} />);
      await vi.advanceTimersByTimeAsync(65_000);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
