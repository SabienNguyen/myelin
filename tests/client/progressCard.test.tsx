// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const { ProgressCard } = await import('../../src/client/components/ProgressCard.js');

const ZERO = {
  byLevel: { mastered: 0, practicing: 0, exposed: 0 },
  earnedThisWeek: 0,
  slipping: 0,
  today: { applied: 0, explained: 0, rubric: 0, struggled: 0, repaired: 0 },
  nextSlip: null,
  calibration: null,
};

const stubProgress = (body: unknown) => {
  const spy = vi.fn(async (url: string) => {
    if (url === '/api/progress') return { ok: true, json: async () => body } as any;
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ProgressCard colophon lines', () => {
  it('shows the today line with zero segments omitted', async () => {
    stubProgress({ ...ZERO, today: { applied: 2, explained: 1, rubric: 0, struggled: 0, repaired: 1 } });
    render(<ProgressCard />);
    expect(await screen.findByText('today: 2 applied · 1 explained · 1 misconception repaired')).toBeTruthy();
  });

  it('a card with ONLY today-activity still renders, and pluralises repaired', async () => {
    stubProgress({ ...ZERO, today: { applied: 0, explained: 0, rubric: 1, struggled: 1, repaired: 2 } });
    render(<ProgressCard />);
    expect(await screen.findByText('today: 1 rubric pass · 1 struggled · 2 misconceptions repaired')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Your progress' })).toBeTruthy();
  });

  it('shows the next-slip line when nothing is slipping yet, as plain text, not a button', async () => {
    stubProgress({
      ...ZERO,
      byLevel: { mastered: 1, practicing: 0, exposed: 0 },
      nextSlip: { slug: 'streams', title: 'Streams', daysLeft: 3 },
    });
    render(<ProgressCard />);
    const line = await screen.findByText(/next slip:/);
    expect(line.textContent).toBe('next slip: Streams, 3d — a quick review keeps it.');
    expect(line.closest('button')).toBeNull();
    expect(screen.getByText('Streams').tagName).toBe('STRONG');
  });

  it('yields the slot to the slipping line once pages are slipping', async () => {
    stubProgress({
      ...ZERO,
      byLevel: { mastered: 1, practicing: 0, exposed: 0 },
      slipping: 2,
      nextSlip: { slug: 'streams', title: 'Streams', daysLeft: 3 },
    });
    render(<ProgressCard />);
    expect(await screen.findByText(/2 pages are slipping — a quick review below locks them back in/)).toBeTruthy();
    expect(screen.queryByText(/next slip:/)).toBeNull();
  });

  // The calibration line only speaks from 5 samples up — a two-sample percentage is noise
  // dressed as feedback.
  it('shows the calibration line at 5+ sure-samples, below the today line', async () => {
    stubProgress({
      ...ZERO,
      today: { ...ZERO.today, applied: 1 },
      calibration: { sureRight: 4, sureTotal: 6 },
    });
    render(<ProgressCard />);
    const line = await screen.findByText('when you say sure, you’re right 4 of 6 times');
    const todayLine = screen.getByText('today: 1 applied');
    // Document order: the calibration line sits below today's colophon.
    expect(todayLine.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides the calibration line below 5 samples, and when the server sent null', async () => {
    stubProgress({ ...ZERO, today: { ...ZERO.today, applied: 1 }, calibration: { sureRight: 4, sureTotal: 4 } });
    render(<ProgressCard />);
    await screen.findByText('today: 1 applied');
    expect(screen.queryByText(/when you say sure/)).toBeNull();
    cleanup();
    stubProgress({ ...ZERO, today: { ...ZERO.today, applied: 1 }, calibration: null });
    render(<ProgressCard />);
    await screen.findByText('today: 1 applied');
    expect(screen.queryByText(/when you say sure/)).toBeNull();
  });

  it('still renders nothing when everything is zero and nextSlip is null', async () => {
    const spy = stubProgress(ZERO);
    const { container } = render(<ProgressCard />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByText('Your progress')).toBeNull();
  });
});
