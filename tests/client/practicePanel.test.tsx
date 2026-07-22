// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const append = vi.fn();
vi.mock('@assistant-ui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return { ...actual, useThreadRuntime: () => ({ append }) };
});

const { PracticePanel } = await import('../../src/client/components/PracticePanel.js');

function mockFetch(effective?: string, mined: any[] = []) {
  return vi.fn(async (url: string) => {
    if (url === '/api/gap/ladder') {
      return {
        ok: true,
        json: async () => ({
          ladder: { pattern: 'stream-consumer', targetArtifactId: 'stream-consumer', siblingArtifactId: 'paginated-fetcher', rungs: [] },
          rungs: [],
          mined,
        }),
      } as any;
    }
    if (url === '/api/student') {
      return {
        ok: true,
        json: async () => (effective ? { 'stream-consumer': { effective, level: effective } } : {}),
      } as any;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => { append.mockClear(); });

describe('PracticePanel', () => {
  it('lists the ladder pattern and clicking it appends the composer message (tutor stays the orchestrator)', async () => {
    vi.stubGlobal('fetch', mockFetch('practicing'));
    render(<PracticePanel />);

    const row = await screen.findByRole('button', { name: /stream-consumer/i });
    fireEvent.click(row);

    expect(append).toHaveBeenCalledExactlyOnceWith('Practice stream-consumer with a code exercise');
  });

  it('maps practicing/mastered -> owned, exposed -> rented, unseen/no-record -> new', async () => {
    vi.stubGlobal('fetch', mockFetch('practicing'));
    const { unmount } = render(<PracticePanel />);
    await waitFor(() => expect(screen.queryByText('owned')).not.toBeNull());
    unmount();
    cleanup();

    vi.stubGlobal('fetch', mockFetch('exposed'));
    const r2 = render(<PracticePanel />);
    await waitFor(() => expect(screen.queryByText('rented')).not.toBeNull());
    r2.unmount();
    cleanup();

    vi.stubGlobal('fetch', mockFetch(undefined));
    render(<PracticePanel />);
    await waitFor(() => expect(screen.queryByText('new')).not.toBeNull());
  });

  it('renders nothing when the gap feature is off (ladder fetch not ok)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) } as any)));
    const { container } = render(<PracticePanel />);
    await waitFor(() => expect(container.querySelector('.practice-panel')).toBeNull());
  });

  it('does not fetch while not visible', () => {
    const fetchMock = mockFetch('practicing');
    vi.stubGlobal('fetch', fetchMock);
    render(<PracticePanel visible={false} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// B2c: mined ladder entries (payload.mined) — listed under a "From your repos" group, clicking
// routes through the tutor exactly like a built-in row.
describe('PracticePanel — mined patterns (B2c)', () => {
  const minedEntry = {
    rung: { id: 'mined-pick--full_body--abc', artifactId: 'packages-core-src-pick', template: 'full_body' },
    meta: { title: 'Pick', family: 'mined:the-gap', source: { repo: '/repo', commit: 'deadbeef', path: 'src/pick.ts' } },
  };

  it('lists a "From your repos" group with the family badge, and appends the pageSlug on click', async () => {
    vi.stubGlobal('fetch', mockFetch(undefined, [minedEntry]));
    render(<PracticePanel />);

    await screen.findByText('From your repos');
    const row = await screen.findByRole('button', { name: /pick/i });
    expect(screen.getByText('mined:the-gap')).not.toBeNull();

    fireEvent.click(row);
    expect(append).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('pageSlug "packages-core-src-pick"'),
    );
  });

  it('renders the mined group even when the built-in ladder has no pattern', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/gap/ladder') {
        return { ok: true, json: async () => ({ ladder: {}, rungs: [], mined: [minedEntry] }) } as any;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
    render(<PracticePanel />);
    await screen.findByText('From your repos');
  });

  it('shows no "From your repos" group when mined is empty', async () => {
    vi.stubGlobal('fetch', mockFetch(undefined, []));
    const { container } = render(<PracticePanel />);
    await waitFor(() => expect(container.querySelector('.practice-panel')).not.toBeNull());
    expect(screen.queryByText('From your repos')).toBeNull();
  });
});
