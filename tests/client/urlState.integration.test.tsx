// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { panelBus } from '../../src/client/lib/panelBus.js';

// GraphPanel (always mounted inside SidePanel, just hidden when its tab isn't active) calls
// useThreadRuntime() unconditionally on every render, which throws outside a real
// AssistantRuntimeProvider. SidePanel is otherwise runtime-agnostic, so stub just that hook
// rather than standing up the full chat Runtime (network calls, chat transport, etc.) this
// wiring test has no need of.
vi.mock('@assistant-ui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return { ...actual, useThreadRuntime: () => ({ append: vi.fn() }) };
});

const { SidePanel } = await import('../../src/client/components/SidePanel.js');

// GraphPanel/LibraryPanel/PagePanel all live inside SidePanel (hidden, not unmounted). Their
// effects fetch only when their tab is active/slug is set, but keep a harmless generic mock in
// place so any fetch that does fire resolves cleanly and quietly.
function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ nodes: [], page: { meta: { title: 'Derivatives' }, body: '' } }),
    }),
  );
}

describe('SidePanel URL deep-linking wiring', () => {
  beforeEach(() => {
    stubFetch();
    location.hash = '';
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    location.hash = '';
  });

  it('panelBus.openPage switches to the page tab and writes /page/<slug> into the hash, preserving threadId', async () => {
    location.hash = '#/t/t-abc123';
    render(<SidePanel />);

    act(() => { panelBus.openPage('derivatives'); });

    await waitFor(() => expect(location.hash).toBe('#/t/t-abc123/page/derivatives'));
    const pageTab = screen.getByRole('tab', { name: 'page' });
    expect(pageTab.getAttribute('aria-selected')).toBe('true');
  });

  it('initializes tab and pageSlug from the hash present at mount', async () => {
    location.hash = '#/t/default/page/chain-rule';
    render(<SidePanel />);

    const pageTab = await screen.findByRole('tab', { name: 'page' });
    expect(pageTab.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/page/chain-rule'));
  });

  it('setting the hash and dispatching hashchange switches the active tab', async () => {
    location.hash = '#/t/default';
    render(<SidePanel />);
    expect(screen.getByRole('tab', { name: 'stage' }).getAttribute('aria-selected')).toBe('true');

    act(() => {
      location.hash = '#/t/default/graph';
      window.dispatchEvent(new Event('hashchange'));
    });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'graph' }).getAttribute('aria-selected')).toBe('true');
    });
  });

  it('does not spam history on repeated tab flips (replaceState, not pushState)', async () => {
    location.hash = '#/t/t-xyz';
    render(<SidePanel />);
    const lengthBefore = history.length;

    act(() => { panelBus.setTab('graph'); });
    await waitFor(() => expect(location.hash).toBe('#/t/t-xyz/graph'));
    act(() => { panelBus.setTab('library'); });
    await waitFor(() => expect(location.hash).toBe('#/t/t-xyz/library'));

    expect(history.length).toBe(lengthBefore);
  });
});
