// @vitest-environment jsdom
//
// Continuous line numbering (docs/superpowers/plans/2026-07-21-coding-stage.md section C):
// mounts the REAL RungEditor (real CM6, not the CodeExercise.tsx `Editor` prop stub — see that
// file's top comment on why jsdom mounting real CM6 is fine, it's only *keystroke* simulation
// into a contentEditable that's fragile) and reads the rendered line-number gutter text directly,
// so these assertions exercise the actual formatNumber offsets rather than re-testing arithmetic
// in isolation.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { RungEditor } from '../../../src/client/components/blocks/gap/RungEditor.js';

afterEach(() => cleanup());

function lineNumberTexts(pane: HTMLElement): string[] {
  // CM6's gutter renders one extra `.cm-gutterElement` — a `visibility: hidden` width-reserving
  // spacer sized off the pane's own max line number (see @codemirror/view's SingleGutterView) —
  // ahead of the real per-line markers. Same selector/class as the real ones, so filter by that
  // inline style rather than position.
  return Array.from(pane.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement'))
    .filter((el) => el.style.visibility !== 'hidden')
    .map((el) => el.textContent ?? '');
}

describe('RungEditor — continuous line numbering across the three panes', () => {
  it('numbers pre from 1, gap continuing from pre, and post continuing from pre+gap', () => {
    const visiblePre = 'function consumeStream(response) {\n  // pre line 2\n';
    const initialGap = 'const a = 1;\nconst b = 2;';
    const visiblePost = '\n  return a + b;\n}';

    const { container } = render(
      <RungEditor
        visiblePre={visiblePre}
        visiblePost={visiblePost}
        initialGap={initialGap}
        onGapChange={() => {}}
      />,
    );

    const preNumbers = lineNumberTexts(container.querySelector('.rung-pane--pre')!);
    const gapNumbers = lineNumberTexts(container.querySelector('.rung-pane--gap')!);
    const postNumbers = lineNumberTexts(container.querySelector('.rung-pane--post')!);

    // pre: visiblePre has 3 lines ("function...{", "  // pre line 2", "") — starts at 1.
    expect(preNumbers).toEqual(['1', '2', '3']);
    // gap: 2 lines, continuing right after pre's 3 lines.
    expect(gapNumbers).toEqual(['4', '5']);
    // post: 3 lines ("", "  return a + b;", "}"), continuing after pre(3) + gap(2).
    expect(postNumbers).toEqual(['6', '7', '8']);
  });

  it('the post pane offset updates live as the gap pane gains lines, and does nothing when the '
    + 'line count is unchanged', () => {
    const visiblePre = 'function f() {\n';
    const visiblePost = '\n}';

    const { container } = render(
      <RungEditor
        visiblePre={visiblePre}
        visiblePost={visiblePost}
        initialGap="const x = 1;"
        onGapChange={() => {}}
      />,
    );

    // pre: 2 lines (1..2). gap: 1 line -> starts at 3. post: 2 lines -> starts at 4.
    expect(lineNumberTexts(container.querySelector('.rung-pane--post')!)).toEqual(['4', '5']);

    const gapContent = container.querySelector('.rung-pane--gap .cm-content') as HTMLElement;

    // Editing WITHIN the same line (no line-count change) must not move the post pane's numbers —
    // exercises the "guard against reconfiguring when the count didn't change" requirement.
    dispatchPaste(gapContent, 'const x = 12;');
    expect(lineNumberTexts(container.querySelector('.rung-pane--post')!)).toEqual(['4', '5']);

    // Adding two lines in the gap DOES move the post pane's offset (gap goes from 1 line to 3).
    dispatchPaste(gapContent, 'const x = 1;\nconst y = 2;\nconst z = 3;');
    expect(lineNumberTexts(container.querySelector('.rung-pane--post')!)).toEqual(['6', '7']);
  });
});

// Real editor, exact content — same technique tests/e2e/gap-exercise.e2e.ts uses against the
// real browser: a synthetic ClipboardEvent('paste') at the CM6 content node, which CM6's own
// paste handler applies as one transaction (select-all first so it REPLACES the doc, matching
// how the e2e test's single paste onto an empty gap behaves).
function dispatchPaste(contentEl: HTMLElement, text: string): void {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(contentEl);
  selection?.removeAllRanges();
  selection?.addRange(range);

  // jsdom implements neither the ClipboardEvent nor DataTransfer constructors — CM6's paste
  // handler only reads `event.clipboardData.getData('text/plain')` and `event.type`, so a plain
  // Event with a hand-attached clipboardData stand-in drives the same code path.
  const clipboardData = { getData: (type: string) => (type === 'text/plain' ? text : '') };
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: clipboardData });
  contentEl.dispatchEvent(event);
}
