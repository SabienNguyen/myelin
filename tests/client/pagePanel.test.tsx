// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { panelBus, type PanelEvent } from '../../src/client/lib/panelBus.js';

const { PagePanel } = await import('../../src/client/components/PagePanel.js');

const payload = (
  misconceptions: string[],
  decay: { daysLeft?: number | null; slipped?: boolean } = {},
  counts: Partial<{ applied: number; explained: number; rubric: number; struggled: number }> = {},
) => ({
  page: { slug: 'stream-consumer', meta: { title: 'Stream consumer', status: 'solid' }, body: 'body text' },
  edges: {}, neighbors: {}, routes: [], noLadder: false,
  standing: {
    level: 'practicing', effective: 'practicing', lastReinforced: '2026-07-27',
    applied: 1, explained: 0, rubric: 0, struggled: 0, ...counts, misconceptions,
    // The panel reads the countdown straight from these server fields (get_student_state's own
    // decayDaysLeft), never re-deriving DECAY windows client-side.
    daysLeft: decay.daysLeft ?? null, slipped: decay.slipped ?? false,
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

  // The countdown is the memory layer's own days_left, not a client re-derivation of DECAY windows
  // (the graph rings and review queue already read it; the page reader was the last re-deriver).
  it('shows the server-reported days_left verbatim, without re-deriving the window', async () => {
    stubPage(payload([], { daysLeft: 13, slipped: false }));
    render(<PagePanel slug="stream-consumer" />);
    expect(await screen.findByText('Holds for 13 more days without practice.')).toBeTruthy();
  });

  it('says "Due for review now." when the memory layer reports the standing has slipped', async () => {
    stubPage(payload([], { daysLeft: null, slipped: true }));
    render(<PagePanel slug="stream-consumer" />);
    await screen.findByText('Stream consumer');
    expect(screen.getByText('Due for review now.')).toBeTruthy();
    expect(screen.queryByText(/Holds for/)).toBeNull();
  });

  it('shows no countdown line when nothing is decaying (daysLeft null, not slipped)', async () => {
    stubPage(payload([], { daysLeft: null, slipped: false }));
    render(<PagePanel slug="stream-consumer" />);
    await screen.findByText('Stream consumer');
    expect(screen.queryByText(/Holds for|Due for review/)).toBeNull();
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

  // The mastered ceiling (engram model.ts: explanation and rubric evidence stop at 'practicing';
  // only machine-checked work reaches 'mastered') must be stated where the learner reads their
  // standing — otherwise "why is this not mastered" has no answer for subjects with no exercise.
  it('explained-only standing says mastered stays out of reach until an exercise confirms it', async () => {
    stubPage(payload([], {}, { applied: 0, explained: 2 }));
    render(<PagePanel slug="stream-consumer" />);
    expect(await screen.findByText(
      'Earned by 2 explanations, judged by the tutor. No exercise has confirmed it — mastered stays out of reach until one does.',
    )).toBeTruthy();
  });

  it('rubric-held standing says mastered needs a machine-checked exercise', async () => {
    stubPage(payload([], {}, { applied: 0, rubric: 1 }));
    render(<PagePanel slug="stream-consumer" />);
    expect(await screen.findByText(
      'Held up by 1 rubric pass — work judged against stated criteria, re-checked sooner than machine-verified work. Mastered needs a machine-checked exercise.',
    )).toBeTruthy();
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

// The claim probe: a page nothing has proven yet offers "claim you know this", which hands the
// tutor a ready-made applied-check request over panelBus (Thread.tsx sends it as a real message).
describe('PagePanel claim probe', () => {
  const captureBus = () => {
    const events: PanelEvent[] = [];
    const unsub = panelBus.subscribe((e) => events.push(e));
    return { events, unsub };
  };

  it('renders on an exposed page and emits askTutor with the page title', async () => {
    stubPage({
      ...payload([]),
      standing: { ...payload([]).standing, level: 'exposed', effective: 'exposed', applied: 0 },
    });
    render(<PagePanel slug="stream-consumer" />);
    const btn = await screen.findByRole('button', { name: 'claim you know this' });
    const { events, unsub } = captureBus();
    try {
      fireEvent.click(btn);
    } finally {
      unsub();
    }
    expect(events).toEqual([{
      type: 'askTutor',
      text: 'I already know "Stream consumer" — give me one quick applied check to prove it, and record the evidence.',
    }]);
  });

  it('renders on a page with no standing at all (effectively unseen)', async () => {
    stubPage({ ...payload([]), standing: null });
    render(<PagePanel slug="stream-consumer" />);
    expect(await screen.findByRole('button', { name: 'claim you know this' })).toBeTruthy();
    expect(screen.getByText('Nothing recorded yet.')).toBeTruthy();
  });

  it('is absent on practicing and mastered pages — the claim is already on the record', async () => {
    stubPage(payload([])); // payload defaults to effective: practicing
    render(<PagePanel slug="stream-consumer" />);
    await screen.findByText('Stream consumer');
    expect(screen.queryByRole('button', { name: 'claim you know this' })).toBeNull();
    cleanup();
    stubPage({
      ...payload([]),
      standing: { ...payload([]).standing, level: 'mastered', effective: 'mastered' },
    });
    render(<PagePanel slug="stream-consumer" />);
    await screen.findByText('Stream consumer');
    expect(screen.queryByRole('button', { name: 'claim you know this' })).toBeNull();
  });
});
