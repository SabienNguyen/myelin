// @vitest-environment jsdom
//
// Pure keyboard/pointer-contract tests — the ARIA window-splitter pattern's value math and the
// double-click/Enter gestures, all of which are deterministic without a real layout. Actual pixel
// dragging needs real geometry (getBoundingClientRect) that jsdom doesn't provide, so the drag
// tests below only exercise clientX deltas, not real hit-testing; the full path is covered by
// tests/e2e/side-panel-layout.e2e.ts against a real browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  WorkspaceSplitter, STEP, COLLAPSE_THRESHOLD, type WorkspaceSplitterProps,
} from '../../src/client/components/WorkspaceSplitter.js';

// jsdom has no Pointer Events capture API — the component calls setPointerCapture on
// pointerdown, which would otherwise throw before any drag test could run.
beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});
afterEach(cleanup);

function renderSplitter(overrides: Partial<WorkspaceSplitterProps> = {}) {
  const onWidthChange = vi.fn();
  const onWidthCommit = vi.fn();
  const onCollapse = vi.fn();
  const onResetDefault = vi.fn();
  const props: WorkspaceSplitterProps = {
    panelId: 'side-panel',
    width: 600,
    min: 320,
    max: 900,
    onWidthChange,
    onWidthCommit,
    onCollapse,
    onResetDefault,
    ...overrides,
  };
  render(<WorkspaceSplitter {...props} />);
  return { onWidthChange, onWidthCommit, onCollapse, onResetDefault };
}

// startWidth is what the splitter reads off the `width` prop at pointerdown, so callers must
// keep it in sync with whatever `width` they passed to renderSplitter.
function drag(startWidth: number, deltaX: number) {
  const sep = separator();
  fireEvent.pointerDown(sep, { clientX: 0 });
  fireEvent.pointerMove(sep, { clientX: -deltaX / 2 });
  fireEvent.pointerMove(sep, { clientX: -deltaX });
  fireEvent.pointerUp(sep, { clientX: -deltaX });
}

const separator = () => screen.getByRole('separator', { name: 'Resize side panel' });

describe('WorkspaceSplitter', () => {
  it('exposes the window-splitter ARIA contract', () => {
    renderSplitter({ width: 600, min: 320, max: 900 });
    const sep = separator();
    expect(sep.getAttribute('aria-orientation')).toBe('vertical');
    expect(sep.getAttribute('aria-controls')).toBe('side-panel');
    expect(sep.getAttribute('aria-valuemin')).toBe('320');
    expect(sep.getAttribute('aria-valuemax')).toBe('900');
    expect(sep.getAttribute('aria-valuenow')).toBe('600');
    expect(sep.getAttribute('tabindex')).toBe('0');
  });

  it('ArrowLeft widens the panel by one step (the splitter moves left)', () => {
    const { onWidthChange, onWidthCommit } = renderSplitter({ width: 600 });
    fireEvent.keyDown(separator(), { key: 'ArrowLeft' });
    expect(onWidthChange).toHaveBeenCalledWith(600 + STEP);
    // A keyboard step is a single discrete action, not a stream like a drag — it persists
    // immediately, unlike a pointermove during a drag (see the drag tests below).
    expect(onWidthCommit).toHaveBeenCalledWith(600 + STEP);
  });

  it('ArrowRight narrows the panel by one step', () => {
    const { onWidthChange, onWidthCommit } = renderSplitter({ width: 600 });
    fireEvent.keyDown(separator(), { key: 'ArrowRight' });
    expect(onWidthChange).toHaveBeenCalledWith(600 - STEP);
    expect(onWidthCommit).toHaveBeenCalledWith(600 - STEP);
  });

  it('Shift quadruples the step in both directions', () => {
    const { onWidthChange } = renderSplitter({ width: 600 });
    fireEvent.keyDown(separator(), { key: 'ArrowLeft', shiftKey: true });
    expect(onWidthChange).toHaveBeenCalledWith(600 + STEP * 4);
    fireEvent.keyDown(separator(), { key: 'ArrowRight', shiftKey: true });
    expect(onWidthChange).toHaveBeenCalledWith(600 - STEP * 4);
  });

  it('Home jumps to the minimum width', () => {
    const { onWidthChange } = renderSplitter({ width: 600, min: 320, max: 900 });
    fireEvent.keyDown(separator(), { key: 'Home' });
    expect(onWidthChange).toHaveBeenCalledWith(320);
  });

  it('End jumps to the maximum width', () => {
    const { onWidthChange } = renderSplitter({ width: 600, min: 320, max: 900 });
    fireEvent.keyDown(separator(), { key: 'End' });
    expect(onWidthChange).toHaveBeenCalledWith(900);
  });

  it('clamps ArrowLeft at the maximum instead of overshooting', () => {
    const { onWidthChange } = renderSplitter({ width: 890, min: 320, max: 900 });
    fireEvent.keyDown(separator(), { key: 'ArrowLeft' });
    expect(onWidthChange).toHaveBeenCalledWith(900);
  });

  it('clamps ArrowRight at the minimum instead of undershooting', () => {
    const { onWidthChange } = renderSplitter({ width: 330, min: 320, max: 900 });
    fireEvent.keyDown(separator(), { key: 'ArrowRight' });
    expect(onWidthChange).toHaveBeenCalledWith(320);
  });

  it('Enter requests a collapse, not a width change', () => {
    const { onCollapse, onWidthChange } = renderSplitter({ width: 600 });
    fireEvent.keyDown(separator(), { key: 'Enter' });
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onWidthChange).not.toHaveBeenCalled();
  });

  it('ignores keys it does not own', () => {
    const { onWidthChange, onCollapse } = renderSplitter({ width: 600 });
    for (const key of ['ArrowUp', 'ArrowDown', 'a', 'Tab']) {
      fireEvent.keyDown(separator(), { key });
    }
    expect(onWidthChange).not.toHaveBeenCalled();
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it('double-click resets to the default split instead of a specific width', () => {
    const { onResetDefault, onWidthChange } = renderSplitter({ width: 600 });
    fireEvent.doubleClick(separator());
    expect(onResetDefault).toHaveBeenCalledTimes(1);
    expect(onWidthChange).not.toHaveBeenCalled();
  });

  // Regression coverage for the bug this file was written to close: a drag that moves the
  // pointer must not commit (persist) anything until release, or a panel dragged shut re-expands
  // at whatever width the pointer passed through on its way down, not the width it started at.
  describe('drag commit contract', () => {
    it('reports live width on every pointermove but never commits mid-drag', () => {
      const { onWidthChange, onWidthCommit } = renderSplitter({ width: 600, min: 320, max: 900 });
      const sep = separator();
      fireEvent.pointerDown(sep, { clientX: 0 });
      fireEvent.pointerMove(sep, { clientX: -50 });
      fireEvent.pointerMove(sep, { clientX: -100 });
      expect(onWidthChange).toHaveBeenCalledWith(650);
      expect(onWidthChange).toHaveBeenCalledWith(700);
      expect(onWidthCommit).not.toHaveBeenCalled();
    });

    it('releasing above the collapse threshold commits exactly the final width once', () => {
      const { onWidthCommit, onCollapse } = renderSplitter({ width: 600, min: 320, max: 900 });
      drag(600, 100); // 600 -> 700, well above COLLAPSE_THRESHOLD
      expect(onWidthCommit).toHaveBeenCalledTimes(1);
      expect(onWidthCommit).toHaveBeenCalledWith(700);
      expect(onCollapse).not.toHaveBeenCalled();
    });

    it('releasing below the collapse threshold collapses instead of committing a width', () => {
      const { onWidthCommit, onCollapse } = renderSplitter({ width: 600, min: 320, max: 900 });
      drag(600, -400); // 600 -> 200, below COLLAPSE_THRESHOLD (240)
      expect(onCollapse).toHaveBeenCalledTimes(1);
      expect(onWidthCommit).not.toHaveBeenCalled();
    });

    it('the collapse threshold is judged on the raw drag position, not the clamped live width', () => {
      // Dragging well past `min` (320) still collapses at release, even though the live width
      // reported through onWidthChange never went below 320 — see the component's own doc
      // comment on why collapse uses the RAW position.
      const { onWidthChange, onCollapse } = renderSplitter({ width: 600, min: 320, max: 900 });
      drag(600, -400); // raw 200, clamped live width bottoms out at 320
      for (const call of onWidthChange.mock.calls) expect(call[0]).toBeGreaterThanOrEqual(320);
      expect(onCollapse).toHaveBeenCalledTimes(1);
    });
  });
});
