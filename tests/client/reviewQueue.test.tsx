// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const append = vi.fn();
vi.mock('@assistant-ui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return { ...actual, useThreadRuntime: () => ({ append }) };
});

const { ReviewQueue } = await import('../../src/client/components/ReviewQueue.js');

const stubDue = (res: { ok?: boolean; status?: number; body?: unknown; throws?: boolean }) => {
  const spy = vi.fn(async (url: string) => {
    if (url !== '/api/due') throw new Error(`unexpected fetch: ${url}`);
    if (res.throws) throw new TypeError('Failed to fetch');
    return { ok: res.ok ?? true, status: res.status ?? 200, json: async () => res.body } as any;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('ReviewQueue failure state', () => {
  it('a failed /api/due keeps the heading and denies that nothing is due', async () => {
    stubDue({ ok: false, status: 502 });
    render(<ReviewQueue />);
    const message = await screen.findByRole('status');
    expect(screen.getByRole('heading', { name: 'Review' })).toBeTruthy();
    expect(message.textContent).toContain('your review queue');
    expect(message.textContent).toContain('not because nothing is due');
  });

  it('an unreachable harness reads as unreachable, not as a clean slate', async () => {
    stubDue({ throws: true });
    const message = (render(<ReviewQueue />), await screen.findByRole('status'));
    expect(message.textContent).toContain('Can’t reach the harness');
  });

  it('a genuinely empty queue still renders nothing — silence now only ever means empty', async () => {
    const spy = stubDue({ body: { due: [], total: 0 } });
    const { container } = render(<ReviewQueue />);
    await waitFor(() => { expect(spy).toHaveBeenCalled(); });
    await waitFor(() => { expect(container.innerHTML).toBe(''); });
  });

  it('a loaded queue still lists its rows and the honest pre-cap count', async () => {
    stubDue({ body: { due: [{ slug: 'streams', title: 'Streams', effective: 'practicing', level: 'mastered', daysLeft: null, slipped: true }], total: 4 } });
    render(<ReviewQueue />);
    expect(await screen.findByText('Streams')).toBeTruthy();
    expect(screen.getByText('slipped from mastered')).toBeTruthy();
    expect(screen.getByText(/Showing the 1 most urgent of 4/)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
