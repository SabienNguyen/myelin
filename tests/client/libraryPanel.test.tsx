// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// LibraryPanel renders PracticePanel, which needs the assistant-ui thread runtime — same seam
// tests/client/practicePanel.test.tsx uses.
vi.mock('@assistant-ui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return { ...actual, useThreadRuntime: () => ({ append: vi.fn() }) };
});

const { LibraryPanel } = await import('../../src/client/components/LibraryPanel.js');

const NO_GAP = { ok: false, status: 404, json: async () => ({}) } as any;

function jsonRes(body: unknown, ok = true) {
  return { ok, json: async () => body } as any;
}

function routedFetch(queue: any[]) {
  return vi.fn(async (url: string, init?: any) => {
    if (url === '/api/ingest/queue') return jsonRes(queue);
    if (url === '/api/status') return jsonRes({ autoCompile: false });
    if (url === '/api/gap/ladder') return NO_GAP; // keep PracticePanel a no-op for these tests
    if (url === '/api/ingest/repo' && init?.method === 'POST') {
      const body = JSON.parse(init.body);
      return jsonRes({ name: body.source.split('/').pop().replace(/\.git$/, ''), ingesting: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('LibraryPanel — Add repo (B2c)', () => {
  it('shows the Add repo form even with an empty queue, beside the "no books yet" note', async () => {
    vi.stubGlobal('fetch', routedFetch([]));
    render(<LibraryPanel />);
    await screen.findByText(/no books yet/i);
    expect(screen.getByPlaceholderText(/git url or local path/i)).not.toBeNull();
    expect(screen.getByRole('button', { name: /^add repo$/i })).not.toBeNull();
  });

  it('submitting the form POSTs to /api/ingest/repo and shows a confirmation note', async () => {
    const fetchMock = routedFetch([]);
    vi.stubGlobal('fetch', fetchMock);
    render(<LibraryPanel />);
    await screen.findByText(/no books yet/i);

    fireEvent.change(screen.getByPlaceholderText(/git url or local path/i), {
      target: { value: 'https://github.com/foo/widgets.git' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^add repo$/i }));

    await screen.findByText(/widgets: ingesting in the background/i);
    expect(fetchMock).toHaveBeenCalledWith('/api/ingest/repo', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ source: 'https://github.com/foo/widgets.git' }),
    }));
  });

  it('renders a repo-mode queue entry with a distinct badge and its phase text', async () => {
    const queue = [
      {
        book: 'widgets', chapter: '__ingesting_repo__/1', title: 'Ingesting repo…', mode: 'repo',
        status: 'converting', phase: 'mining…', sourceUrl: 'https://github.com/foo/widgets.git',
      },
    ];
    vi.stubGlobal('fetch', routedFetch(queue));
    render(<LibraryPanel />);

    await screen.findByText('widgets');
    expect(screen.getByText('repo')).not.toBeNull(); // the distinct badge
    expect(screen.getByText('mining…')).not.toBeNull();
  });

  it('shows the final pages/exercises summary once a repo entry is done', async () => {
    const queue = [
      {
        book: 'widgets', chapter: '__ingesting_repo__/1', title: 'Ingesting repo…', mode: 'repo',
        status: 'done', phase: 'pages: 2 queued, exercises: 1', sourceUrl: 'https://github.com/foo/widgets.git',
      },
    ];
    vi.stubGlobal('fetch', routedFetch(queue));
    render(<LibraryPanel />);

    await screen.findByText('pages: 2 queued, exercises: 1');
  });

  it('a doc-pass chapter queued under the same repo book renders as a normal pending row', async () => {
    const queue = [
      {
        book: 'widgets', chapter: '__ingesting_repo__/1', title: 'Ingesting repo…', mode: 'repo',
        status: 'done', phase: 'pages: 1 queued, exercises: 0', sourceUrl: 'https://github.com/foo/widgets.git',
      },
      {
        book: 'widgets', chapter: 'raw/uploads/widgets/readme--ch-01-intro.md', title: 'Intro',
        status: 'pending', sourceUrl: 'https://github.com/foo/widgets.git — README.md',
      },
    ];
    vi.stubGlobal('fetch', routedFetch(queue));
    render(<LibraryPanel />);

    await screen.findByText('widgets');
    expect(screen.getByText('Intro', { exact: false })).not.toBeNull();
    await waitFor(() => expect(screen.getByText('pending')).not.toBeNull());
  });
});
