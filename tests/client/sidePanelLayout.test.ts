// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSidePanelLayout } from '../../src/client/lib/sidePanelLayout.js';

const WIDTH_KEY = 'myelin.sidePanel.width';
const COLLAPSED_KEY = 'myelin.sidePanel.collapsed';

describe('useSidePanelLayout', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('defaults to collapsed with no saved width — an empty panel is dead weight until something stages', () => {
    const { result } = renderHook(() => useSidePanelLayout());
    expect(result.current.collapsed).toBe(true);
    expect(result.current.width).toBeNull();
  });

  it('a stored "false" wins over the collapsed default — the 1.4fr/1fr split stays in charge', () => {
    localStorage.setItem(COLLAPSED_KEY, 'false');
    const { result } = renderHook(() => useSidePanelLayout());
    expect(result.current.collapsed).toBe(false);
  });

  it('persists a width change and restores it for a fresh mount', () => {
    const { result, unmount } = renderHook(() => useSidePanelLayout());
    act(() => { result.current.setWidth(480); });
    expect(result.current.width).toBe(480);
    expect(localStorage.getItem(WIDTH_KEY)).toBe('480');
    unmount();

    const { result: reopened } = renderHook(() => useSidePanelLayout());
    expect(reopened.current.width).toBe(480);
  });

  it('setWidth(null) clears the saved width — back to the fluid default split', () => {
    const { result } = renderHook(() => useSidePanelLayout());
    act(() => { result.current.setWidth(480); });
    act(() => { result.current.setWidth(null); });
    expect(result.current.width).toBeNull();
    expect(localStorage.getItem(WIDTH_KEY)).toBeNull();
  });

  it('persists collapsed and restores it for a fresh mount', () => {
    const { result, unmount } = renderHook(() => useSidePanelLayout());
    act(() => { result.current.setCollapsed(true); });
    expect(result.current.collapsed).toBe(true);
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('true');
    unmount();

    const { result: reopened } = renderHook(() => useSidePanelLayout());
    expect(reopened.current.collapsed).toBe(true);
  });

  it('setLiveWidth updates the live value without writing to storage', () => {
    const { result } = renderHook(() => useSidePanelLayout());
    act(() => { result.current.setLiveWidth(555); });
    expect(result.current.liveWidth).toBe(555);
    expect(result.current.width).toBeNull();
    expect(localStorage.getItem(WIDTH_KEY)).toBeNull();
  });

  it('setWidth persists and clears any pending live override', () => {
    const { result } = renderHook(() => useSidePanelLayout());
    act(() => { result.current.setLiveWidth(250); });
    act(() => { result.current.setWidth(600); });
    expect(result.current.width).toBe(600);
    expect(result.current.liveWidth).toBeNull();
    expect(localStorage.getItem(WIDTH_KEY)).toBe('600');
  });

  it('a throwing localStorage falls back to defaults without an error escaping', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });

    let hook!: ReturnType<typeof renderHook<ReturnType<typeof useSidePanelLayout>, unknown>>;
    expect(() => { hook = renderHook(() => useSidePanelLayout()); }).not.toThrow();
    expect(hook.result.current.collapsed).toBe(true);
    expect(hook.result.current.width).toBeNull();

    // Writes must not throw either — a blocked store just means the session forgets on reload.
    expect(() => act(() => {
      hook.result.current.setWidth(500);
      hook.result.current.setCollapsed(true);
    })).not.toThrow();
    expect(hook.result.current.width).toBe(500);
    expect(hook.result.current.collapsed).toBe(true);
  });
});
