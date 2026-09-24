// @vitest-environment jsdom
// pageTitles.ts's module-level cache: a transcript can mount many tool chips and wiki links for
// the same slug, so this pins what keeps that cheap — one shared in-flight fetch, a throttled
// retry on a cache miss, and a failed fetch that logs instead of vanishing.
//
// Each test imports a fresh module (vi.resetModules() + dynamic import) instead of a module-
// exported reset, because the cache is module-level singleton state that would otherwise leak
// between tests; 'react' itself is never reset, so rendering through it here stays safe.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function freshPageTitles() {
  vi.resetModules();
  return import('../../src/client/lib/pageTitles.js');
}

function stubGraph(fetchImpl: () => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
}

/** Renders a slug's title through whichever module instance `useTitle` came from — a plain prop,
 *  not an import, so each test can hand it a fresh pageTitles module. */
function Probe({ slug, useTitle }: { slug: string; useTitle: (s: string) => string | undefined }) {
  const title = useTitle(slug);
  return <span>{title ?? '…'}</span>;
}

/** The reverse of Probe: a title in, the slug it resolves to (or the same '…' fallback) out —
 *  for usePageSlugForTitle, the citation chip's lookup direction. */
function SlugProbe({ title, useSlug }: { title: string; useSlug: (t: string) => string | undefined }) {
  const slug = useSlug(title);
  return <span>{slug ?? '…'}</span>;
}

describe('pageTitles cache', () => {
  it('concurrent first uses share ONE in-flight getGraph() call', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ nodes: [{ slug: 'a', title: 'A' }, { slug: 'b', title: 'B' }] }),
    }));
    stubGraph(fetchMock);
    const { usePageTitle } = await freshPageTitles();

    render(
      <>
        <Probe slug="a" useTitle={usePageTitle} />
        <Probe slug="b" useTitle={usePageTitle} />
      </>,
    );
    await screen.findByText('A');
    await screen.findByText('B');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a slug missing from the cache refetches, at most once per 15s across all callers', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      // The first graph only has 'a' — 'c' is a page written later in the conversation, absent
      // from the cache until a refetch picks it up.
      const nodes = calls === 1
        ? [{ slug: 'a', title: 'A' }]
        : [{ slug: 'a', title: 'A' }, { slug: 'c', title: 'C' }];
      return { ok: true, status: 200, json: async () => ({ nodes }) };
    });
    stubGraph(fetchMock);
    const { usePageTitle } = await freshPageTitles();

    render(<Probe slug="a" useTitle={usePageTitle} />);
    await screen.findByText('A');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 'c' is a miss right after the first fetch — still inside the 15s window, so no new call,
    // and the probe stays on its honest "unresolved" fallback.
    cleanup();
    render(<Probe slug="c" useTitle={usePageTitle} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('…')).toBeTruthy();

    // Past the throttle window, the same miss fires the retry and resolves.
    now += 15_001;
    cleanup();
    render(<Probe slug="c" useTitle={usePageTitle} />);
    await screen.findByText('C');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failed fetch is logged with the [titles] prefix, not swallowed — callers keep falling back', async () => {
    stubGraph(async () => { throw new Error('network down'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { usePageTitle } = await freshPageTitles();

    render(<Probe slug="a" useTitle={usePageTitle} />);
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(screen.getByText('…')).toBeTruthy();
    expect(String(errorSpy.mock.calls[0][0])).toContain('[titles]');
  });
});

describe('usePageSlugForTitle', () => {
  it('resolves an exact title and a case-insensitively different one from the same one fetch', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ nodes: [{ slug: 'kv-cache', title: 'The KV Cache' }] }),
    }));
    stubGraph(fetchMock);
    const { usePageSlugForTitle } = await freshPageTitles();

    render(
      <>
        <SlugProbe title="The KV Cache" useSlug={usePageSlugForTitle} />
        <SlugProbe title="the kv cache" useSlug={usePageSlugForTitle} />
      </>,
    );
    const resolved = await screen.findAllByText('kv-cache');
    expect(resolved).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stays unresolved, without crashing, for a title with no matching page', async () => {
    stubGraph(async () => ({
      ok: true, status: 200,
      json: async () => ({ nodes: [{ slug: 'kv-cache', title: 'The KV Cache' }] }),
    }));
    const { usePageSlugForTitle } = await freshPageTitles();

    render(<SlugProbe title="Something Never Cited" useSlug={usePageSlugForTitle} />);
    // Give the fetch a tick to resolve, then confirm the miss stays a miss rather than crashing
    // or matching the unrelated cached page.
    await waitFor(() => expect(screen.getByText('…')).toBeTruthy());
  });
});
