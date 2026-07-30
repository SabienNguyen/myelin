// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { panelBus } from '../../src/client/lib/panelBus.js';

// Same stub as urlState.integration.test.tsx: GraphPanel (mounted but hidden inside SidePanel)
// calls useThreadRuntime() unconditionally, which throws outside a real runtime provider.
vi.mock('@assistant-ui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return { ...actual, useThreadRuntime: () => ({ append: vi.fn() }) };
});

const { SidePanel } = await import('../../src/client/components/SidePanel.js');

const KNOWN_NODES = [
  { slug: 'derivatives', title: 'Derivatives', prereqs: [], deepens: [], mastery: { effective: 'practicing' } },
  { slug: 'limits', title: 'Limits', prereqs: [], deepens: [], mastery: { effective: 'unseen' } },
];
const UNPROVEN_NODES = [
  { slug: 'limits', title: 'Limits', prereqs: [], deepens: [], mastery: { effective: 'exposed' } },
];

/** /api/graph answers with `nodes` (deferrable); everything else resolves quietly. */
function stubFetch(nodes: unknown[], graphGate?: Promise<void>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/graph')) {
      if (graphGate) await graphGate;
      return { ok: true, json: async () => ({ nodes }) } as any;
    }
    // LibraryPanel's ProgressCard renders whenever a test lands on the library tab and reads this
    // shape unguarded — a bare {} crashes it.
    if (String(url).startsWith('/api/progress')) {
      return {
        ok: true,
        json: async () => ({
          byLevel: { mastered: 0, practicing: 0, exposed: 0 }, earnedThisWeek: 0, slipping: 0,
          today: { applied: 0, explained: 0, rubric: 0, struggled: 0, repaired: 0 },
          nextSlip: null, calibration: null,
        }),
      } as any;
    }
    return { ok: true, json: async () => ({}) } as any;
  }));
}

const selectedTab = () =>
  screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')?.textContent;

describe('SidePanel map-as-home', () => {
  beforeEach(() => { location.hash = ''; });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); location.hash = ''; });

  it('opens on the graph tab when the hash named no tab and known pages exist', async () => {
    stubFetch(KNOWN_NODES);
    location.hash = '#/t/t-abc';
    render(<SidePanel />);
    await waitFor(() => expect(selectedTab()).toBe('graph'));
  });

  it('stays on stage when nothing is practicing or mastered', async () => {
    stubFetch(UNPROVEN_NODES);
    location.hash = '#/t/t-abc';
    render(<SidePanel />);
    // The negative needs the fetch to have actually resolved before it means anything.
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/graph'));
    await act(async () => {});
    expect(selectedTab()).toBe('stage');
  });

  it('never overrides a tab the hash named explicitly', async () => {
    stubFetch(KNOWN_NODES);
    location.hash = '#/t/t-abc/library';
    render(<SidePanel />);
    await act(async () => {});
    expect(selectedTab()).toBe('library');
    // And the deep-linked stage spelling holds too — explicit is explicit.
    cleanup();
    location.hash = '#/t/t-abc/stage';
    render(<SidePanel />);
    await act(async () => {});
    expect(selectedTab()).toBe('stage');
  });

  it('a user click that beats the fetch wins, even a click on stage itself', async () => {
    let open!: () => void;
    stubFetch(KNOWN_NODES, new Promise<void>((r) => { open = r; }));
    location.hash = '#/t/t-abc';
    render(<SidePanel />);
    // The learner re-affirms the stage tab while /api/graph is still in flight.
    fireEvent.click(screen.getByRole('tab', { name: 'stage' }));
    await act(async () => { open(); });
    await act(async () => {});
    expect(selectedTab()).toBe('stage');
  });

  it('a panelBus setTab that beats the fetch wins', async () => {
    let open!: () => void;
    stubFetch(KNOWN_NODES, new Promise<void>((r) => { open = r; }));
    location.hash = '#/t/t-abc';
    render(<SidePanel />);
    act(() => { panelBus.setTab('library'); });
    await act(async () => { open(); });
    await act(async () => {});
    expect(selectedTab()).toBe('library');
  });
});
