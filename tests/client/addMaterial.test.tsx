// @vitest-environment jsdom
// The single add entry point (topbar). One control for every kind of material: a browsed/dropped
// file goes to POST /api/ingest, a pasted git URL or local folder path to POST /api/ingest/repo.
// These tests pin the routing and the honest failure surface — the two behaviors that used to be
// split across "Add book" (App.tsx) and "Add repo" (LibraryPanel.tsx).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AddMaterial } from '../../src/client/components/AddMaterial.js';

function jsonRes(body: unknown, ok = true) {
  return { ok, json: async () => body } as any;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: /add material/i }));
  return screen.getByRole('dialog', { name: /add material/i });
}

describe('AddMaterial — the one entry point', () => {
  it('renders exactly one add affordance until opened', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<AddMaterial />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /add material/i })).not.toBeNull();
  });

  it('a pasted git URL routes to /api/ingest/repo and reports the queued ingest', async () => {
    const fetchMock = vi.fn(async () => jsonRes({ name: 'widgets', ingesting: true }));
    vi.stubGlobal('fetch', fetchMock);
    render(<AddMaterial />);
    openPanel();

    fireEvent.change(screen.getByLabelText(/git url or local folder path/i), {
      target: { value: 'https://github.com/foo/widgets.git' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await screen.findByText(/widgets: ingesting in the background/i);
    expect(fetchMock).toHaveBeenCalledWith('/api/ingest/repo', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ source: 'https://github.com/foo/widgets.git' }),
    }));
    // Success closes the panel — the Library shows the queued row from here on.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a browsed file routes to /api/ingest as multipart and points at the Library', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: any) => jsonRes({ book: 'midterm-2', converting: true }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<AddMaterial />);
    openPanel();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain('.md'); // typed notes and problem sets need no converter
    expect(input.accept).toContain('.txt');
    const file = new File(['1. What is 2+2?'], 'midterm-2.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByText(/midterm-2: converting in the background/i);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/ingest');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('a failed repo ingest keeps the panel open and names the failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ error: 'no such path' }, false)));
    render(<AddMaterial />);
    openPanel();
    fireEvent.change(screen.getByLabelText(/git url or local folder path/i), {
      target: { value: '/nowhere' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await screen.findByText(/add failed: no such path/i);
    expect(screen.getByRole('dialog')).not.toBeNull();
  });

  it('Escape closes the panel', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<AddMaterial />);
    openPanel();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
