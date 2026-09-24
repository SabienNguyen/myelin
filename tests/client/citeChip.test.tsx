// @vitest-environment jsdom
// A citation chip is WikiLink's `#/cite/<title>` branch (MarkdownText.tsx): citationLinks
// (panelBus.ts) produces that href for a "Vault: <title>" ref inside chat text, and this is the
// render side — a link back to the cited page once the title resolves against the graph cache, a
// plain non-interactive span while it doesn't (an unresolved title has nowhere useful to send a
// click).
//
// Every test imports RichMarkdown fresh via vi.resetModules(): pageTitles.ts's cache is a
// module-level singleton shared by every import in the process, so a stubbed graph from another
// test in this file — or another file Vitest happens to run alongside it — would otherwise leak
// in. Same pattern as tests/client/pageTitles.test.tsx and toolStatusChip.test.tsx's freshChip().
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Stubs /api/graph (via getGraph -> getJson -> fetch) with a fixed node list, Response-like
 *  enough for getJson's ok/status/json contract. Returns the mock so a caller can wait on it
 *  having been asked, when a test needs to know the async fetch has actually settled. */
function stubGraph(nodes: Array<{ slug: string; title: string }>) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ nodes }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function freshRichMarkdown() {
  vi.resetModules();
  const [rich, bus] = await Promise.all([
    import('../../src/client/components/RichMarkdown.js'),
    import('../../src/client/lib/panelBus.js'),
  ]);
  return { RichMarkdown: rich.RichMarkdown, panelBus: bus.panelBus };
}

describe('citation chip (WikiLink\'s #/cite/ branch)', () => {
  it('a resolved title renders a link named "source: <title>", classed cite-chip, that opens the page on click', async () => {
    stubGraph([{ slug: 'kv-cache', title: 'The KV Cache' }]);
    const { RichMarkdown, panelBus } = await freshRichMarkdown();
    const seen: string[] = [];
    const off = panelBus.subscribe((e) => { if (e.type === 'openPage') seen.push(e.slug); });

    render(<RichMarkdown text="[The KV Cache](#/cite/The%20KV%20Cache)" />);
    // Async: usePageSlugForTitle only resolves once the graph fetch it triggers comes back.
    const link = await screen.findByRole('link', { name: 'source: The KV Cache' });
    expect(link.classList.contains('cite-chip')).toBe(true);
    expect(link.getAttribute('href')).toBe('#/page/kv-cache');
    expect(link.getAttribute('title')).toBe('The KV Cache');

    fireEvent.click(link);
    expect(seen).toEqual(['kv-cache']);
    off();
  });

  it('an unknown title renders a non-interactive span carrying the title text, never a link', async () => {
    const fetchMock = stubGraph([{ slug: 'kv-cache', title: 'The KV Cache' }]);
    const { RichMarkdown } = await freshRichMarkdown();

    render(<RichMarkdown text="[Some Other Paper](#/cite/Some%20Other%20Paper)" />);
    // Let the (unsuccessful) resolve attempt actually run before asserting the negative — a
    // synchronous check right after render would pass trivially, before ensureFresh's fetch has
    // even been asked, and would not exercise the "fetched but still no match" path.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const chip = screen.getByText('Some Other Paper');
    expect(chip.tagName).toBe('SPAN');
    expect(chip.classList.contains('cite-chip')).toBe(true);
    expect(chip.getAttribute('aria-label')).toBe('source: Some Other Paper');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('a malformed percent-encoding falls back to the raw text instead of crashing the render', async () => {
    // decodeURIComponent('100%') throws (a lone trailing '%' is not a valid escape) — a citation
    // chip is untrusted model output, and a broken href must degrade to something visible rather
    // than take the whole message down.
    stubGraph([]);
    const { RichMarkdown } = await freshRichMarkdown();

    render(<RichMarkdown text="[bad](#/cite/100%)" />);
    const chip = screen.getByText('100%');
    expect(chip.tagName).toBe('SPAN');
    expect(chip.classList.contains('cite-chip')).toBe(true);
  });
});
