// @vitest-environment jsdom
// The reader's one affordance, driven WITHOUT a mouse: selection arrives via the document's
// selectionchange event — the only channel a screen reader's text-selection commands or caret
// browsing have. (The original mouseup-only listener meant keyboard-made selections never
// surfaced the ask button at all.)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { SourceReader } from '../../src/client/components/SourceReader.js';

const append = vi.fn();
vi.mock('@assistant-ui/react', () => ({
  useThreadRuntime: () => ({ append }),
}));

// jsdom has no layout: Range.getBoundingClientRect does not exist there (it does in every real
// browser). The component reads it for positioning only — give it a flat rect.
beforeEach(() => {
  (Range.prototype as any).getBoundingClientRect ??=
    () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  append.mockClear();
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    json: async () => ({ markdown: 'The ring at radius r has circumference two pi r, a fact worth sitting with.' }),
  })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); cleanup(); });

async function renderLoaded() {
  render(<SourceReader path="raw/uploads/x/paper.md" title="The essence of calculus" onClose={() => {}} />);
  await act(async () => { await vi.runAllTimersAsync(); });
  return screen.getByText(/circumference two pi r/);
}

function selectWithin(node: Node, from: number, to: number) {
  const textNode = node.firstChild ?? node;
  const range = document.createRange();
  range.setStart(textNode, from);
  range.setEnd(textNode, to);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  // jsdom does not fire selectionchange itself — dispatch it as the browser would.
  document.dispatchEvent(new Event('selectionchange'));
}

describe('SourceReader select-to-ask', () => {
  it('a selection made with no mouse at all surfaces the ask button (selectionchange)', async () => {
    const para = await renderLoaded();
    selectWithin(para, 4, 30);
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(screen.getByRole('button', { name: /ask the tutor about this/i })).not.toBeNull();
  });

  it('clicking it sends the quoted passage and clears the affordance', async () => {
    const para = await renderLoaded();
    selectWithin(para, 0, 26);
    await act(async () => { vi.advanceTimersByTime(200); });
    fireEvent.click(screen.getByRole('button', { name: /ask the tutor about this/i }));
    expect(append).toHaveBeenCalledTimes(1);
    const msg = append.mock.calls[0][0] as string;
    expect(msg).toContain('From the source “The essence of calculus”');
    expect(msg).toContain('> The ring at radius r has c');
    expect(screen.queryByRole('button', { name: /ask the tutor/i })).toBeNull();
  });

  it('a collapsed selection clears the button instead of leaving it stranded', async () => {
    const para = await renderLoaded();
    selectWithin(para, 4, 30);
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(screen.getByRole('button', { name: /ask the tutor/i })).not.toBeNull();
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(screen.queryByRole('button', { name: /ask the tutor/i })).toBeNull();
  });
});
