// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const { LinkDirectory } = await import('../../src/client/components/LinkDirectory.js');

const directory = {
  name: 'awesome-scalability',
  source: 'https://github.com/x/awesome-scalability',
  file: 'README.md',
  savedAt: '2026-07-29T00:00:00.000Z',
  sections: [
    {
      title: 'Principles',
      links: [
        { title: 'Scale cube', url: 'https://e.com/cube', note: 'three axes of scaling' },
        { title: 'CAP refresher', url: 'https://e.com/cap' },
      ],
    },
  ],
  total: 2,
  omitted: 0,
};

function stubFetch(onIngest?: (body: any) => void) {
  return vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/linklists') return { ok: true, json: async () => [directory] } as any;
    if (url === '/api/ingest') {
      onIngest?.(JSON.parse(String(init?.body)));
      return { ok: true, json: async () => ({ book: 'Scale cube' }) } as any;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('LinkDirectory', () => {
  it('renders the catalogue: name, meta line, sections, links with notes', async () => {
    stubFetch();
    render(<LinkDirectory queuedUrls={new Set()} />);
    expect(await screen.findByRole('heading', { name: 'awesome-scalability' })).toBeTruthy();
    expect(screen.getByText(/link directory — 2 links from README\.md/)).toBeTruthy();
    expect(screen.getByText('Principles (2)')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Scale cube' })).toBeTruthy();
    expect(screen.getByText('three axes of scaling')).toBeTruthy();
  });

  it('add sends the link through the single ingest door and flips to added', async () => {
    const bodies: any[] = [];
    stubFetch((b) => bodies.push(b));
    render(<LinkDirectory queuedUrls={new Set()} />);
    const btn = await screen.findByRole('button', { name: 'add Scale cube to the library' });
    fireEvent.click(btn);
    expect(await screen.findByText('added')).toBeTruthy();
    expect(bodies).toEqual([{ url: 'https://e.com/cube' }]);
  });

  it('a link already in the ledger shows as added, no button', async () => {
    stubFetch();
    render(<LinkDirectory queuedUrls={new Set(['https://e.com/cap'])} />);
    await screen.findByRole('heading', { name: 'awesome-scalability' });
    expect(screen.queryByRole('button', { name: 'add CAP refresher to the library' })).toBeNull();
    expect(screen.getAllByText('added')).toHaveLength(1);
  });

  it('renders nothing when no directories exist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] }) as any));
    const { container } = render(<LinkDirectory queuedUrls={new Set()} />);
    await vi.waitFor(() => expect((fetch as any).mock.calls.length).toBeGreaterThan(0));
    expect(container.innerHTML).toBe('');
  });

  it('dismiss deletes the catalogue and removes it from view', async () => {
    const deletes: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/linklists' && init?.method === 'DELETE') {
        deletes.push(JSON.parse(String(init.body)));
        return { ok: true, json: async () => ({}) } as any;
      }
      if (url === '/api/linklists') return { ok: true, json: async () => [directory] } as any;
      throw new Error(`unexpected fetch: ${url}`);
    }));
    render(<LinkDirectory queuedUrls={new Set()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'dismiss the awesome-scalability link directory' }));
    await vi.waitFor(() => expect(screen.queryByRole('heading', { name: 'awesome-scalability' })).toBeNull());
    expect(deletes).toEqual([{ name: 'awesome-scalability' }]);
  });
});
