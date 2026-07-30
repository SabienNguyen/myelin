// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

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

function routedFetch(queue: any[], bank: any[] = [], sources: any[] = []) {
  return vi.fn(async (url: string) => {
    if (url === '/api/ingest/queue') return jsonRes(queue);
    if (url === '/api/sources') return jsonRes(sources);
    if (url === '/api/status') return jsonRes({ autoCompile: false });
    if (url === '/api/gap/ladder') return NO_GAP; // keep PracticePanel a no-op for these tests
    if (url === '/api/course-bank') return jsonRes({ sources: bank });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('LibraryPanel — the single add entry point lives in the topbar, not here', () => {
  it('renders NO add control of its own (the "Add repo" form is gone — AddMaterial owns ingestion)', async () => {
    vi.stubGlobal('fetch', routedFetch([]));
    render(<LibraryPanel />);
    await screen.findByText(/no books yet/i);
    expect(screen.getByText(/add material/i)).not.toBeNull(); // empty state points at the topbar
    expect(screen.queryByRole('button', { name: /add/i })).toBeNull();
    expect(screen.queryByPlaceholderText(/git url/i)).toBeNull();
  });
});

describe('LibraryPanel — Course practice section', () => {
  it('lists each banked source with its problem count and never-answered count', async () => {
    vi.stubGlobal('fetch', routedFetch([], [
      { source: 'midterm-2', problems: 4, fresh: 3 },
      { source: 'pset-7', problems: 5, fresh: 0 },
    ]));
    render(<LibraryPanel />);
    await screen.findByText('Course practice');
    expect(screen.getByText('midterm-2')).not.toBeNull();
    expect(screen.getByText(/4 problems · 3 never answered/)).not.toBeNull();
    expect(screen.getByText(/5 problems · all answered/)).not.toBeNull();
  });

  it('an empty bank renders no section at all — not an empty shell', async () => {
    vi.stubGlobal('fetch', routedFetch([]));
    render(<LibraryPanel />);
    await screen.findByText(/no books yet/i);
    expect(screen.queryByText('Course practice')).toBeNull();
  });
});

describe('LibraryPanel — bylines say how much they are worth', () => {
  const row = (book: string) => ({
    book, chapter: `raw/uploads/${book}/ch-01-a.md`, title: 'Chapter one', status: 'pending',
  });

  it('a verified byline reads plainly — the platform said so', async () => {
    vi.stubGlobal('fetch', routedFetch([row('How semiconductors work')], [], [
      { book: 'How semiconductors work', authors: ['Branch Education'], attribution: 'verified' },
    ]));
    render(<LibraryPanel />);
    await waitFor(() => expect(screen.getByText('by Branch Education')).not.toBeNull());
    expect(screen.queryByText(/unverified/)).toBeNull();
  });

  it('a claimed byline is labelled unverified rather than shown as fact', async () => {
    vi.stubGlobal('fetch', routedFetch([row('Some Paper')], [], [
      { book: 'Some Paper', authors: ['Andrej Karpathy'], attribution: 'claimed' },
    ]));
    render(<LibraryPanel />);
    await waitFor(() => expect(screen.getByText('by Andrej Karpathy (unverified)')).not.toBeNull());
  });

  it('a caught mismatch names who was actually credited and that the claim was wrong', async () => {
    vi.stubGlobal('fetch', routedFetch([row('How semiconductors work')], [], [
      {
        book: 'How semiconductors work', authors: ['Branch Education'], attribution: 'verified',
        attributionWarning: 'attributed to 3Blue1Brown, but the source itself credits Branch Education',
      },
    ]));
    render(<LibraryPanel />);
    await waitFor(() => expect(
      screen.getByText('attributed to 3Blue1Brown, but the source itself credits Branch Education'),
    ).not.toBeNull());
    expect(screen.getByText('by Branch Education')).not.toBeNull();
  });

  it('a source with no known authors shows no byline at all — no invented line', async () => {
    vi.stubGlobal('fetch', routedFetch([row('Mystery Upload')], [], [
      { book: 'Mystery Upload', authors: [], attribution: 'unknown' },
    ]));
    render(<LibraryPanel />);
    await screen.findByText('Mystery Upload');
    expect(screen.queryByText(/^by /)).toBeNull();
  });
});

describe('LibraryPanel — repo queue rows', () => {
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
