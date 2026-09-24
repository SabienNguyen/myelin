// @vitest-environment jsdom
// GraphPanel resolves its colours once at mount and never listened for a scheme change, so
// switching the OS from dark to light left the graph's labels and slip ring on their old colours
// until a reload. useColorScheme is the live signal that fixes that — this pins its contract in
// isolation (jsdom has no real matchMedia, so a fake MediaQueryList stands in): dark by default,
// a live 'light' after the OS actually changes, the change listener removed on unmount, and 'dark'
// when matchMedia itself is unavailable.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { render, cleanup, screen } from '@testing-library/react';
import { useColorScheme } from '../../src/client/lib/colorScheme.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Probe() {
  const scheme = useColorScheme();
  return <span>{scheme}</span>;
}

/** A MediaQueryList stand-in with just enough behaviour for this hook: `matches`, and a
 *  change-listener registry the test can fire itself — real jsdom has no matchMedia at all, so
 *  there is no browser implementation to delegate to here. */
function fakeMediaQueryList(initialMatches: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mql = {
    matches: initialMatches,
    addEventListener: (_event: string, listener: (e: { matches: boolean }) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_event: string, listener: (e: { matches: boolean }) => void) => {
      listeners.delete(listener);
    },
  };
  const fire = (matches: boolean) => {
    mql.matches = matches;
    for (const listener of listeners) listener({ matches });
  };
  return { mql, fire, listeners };
}

describe('useColorScheme', () => {
  it('reads dark by default and switches live to light when the MediaQueryList fires change', () => {
    const { mql, fire } = fakeMediaQueryList(false);
    vi.stubGlobal('matchMedia', vi.fn(() => mql));

    render(<Probe />);
    expect(screen.getByText('dark')).toBeTruthy();

    act(() => { fire(true); });
    expect(screen.getByText('light')).toBeTruthy();

    act(() => { fire(false); });
    expect(screen.getByText('dark')).toBeTruthy();
  });

  it('removes its change listener on unmount, so an unmounted GraphPanel is never notified again', () => {
    const { mql, listeners } = fakeMediaQueryList(false);
    vi.stubGlobal('matchMedia', vi.fn(() => mql));

    const { unmount } = render(<Probe />);
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it('returns dark when matchMedia is unavailable, matching styles.css\'s dark :root default', () => {
    vi.stubGlobal('matchMedia', undefined);
    render(<Probe />);
    expect(screen.getByText('dark')).toBeTruthy();
  });
});
