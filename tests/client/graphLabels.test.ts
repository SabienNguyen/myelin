import { describe, it, expect } from 'vitest';
import { fitLabel, hoverLabelBox } from '../../src/client/graph/labels.js';

// Real canvas measureText depends on font metrics; a flat 7px/char stand-in keeps every expected
// number in this file arithmetic instead of tied to whatever font the test runner has installed.
const measure = (text: string) => text.length * 7;
const ELLIPSIS = '…';

describe('fitLabel', () => {
  it('places the label to the right of the node when it fits there', () => {
    expect(fitLabel('Attention Head', 100, 10, 600, measure)).toEqual({
      text: 'Attention Head', x: 113, align: 'left',
    });
  });

  it('flips to the left when the right side lacks room but the left has it', () => {
    // Node sits 7px from the right edge of a 200px canvas — nowhere near enough for "Softmax"
    // (49px) on the right, but the whole rest of the canvas is open on the left.
    expect(fitLabel('Softmax', 180, 10, 200, measure)).toEqual({
      text: 'Softmax', x: 167, align: 'right',
    });
  });

  it('truncates onto the roomier side, with a trailing ellipsis, when neither side fits the full label', () => {
    // Node just left of centre in a narrow 120px canvas: right has 28px of room, left has 68px —
    // the 280px label (40 chars) fits neither, so it truncates onto the roomier left side.
    const label = 'B'.repeat(40);
    const result = fitLabel(label, 80, 5, 120, measure);
    expect(result).toEqual({ text: `${'B'.repeat(8)}${ELLIPSIS}`, x: 72, align: 'right' });
    // The truncated text actually fits the room it was placed in (68px on the left).
    expect(measure(result!.text)).toBeLessThanOrEqual(68);
  });

  it('trims trailing spaces from the prefix before appending the ellipsis', () => {
    // "AAAA" then a run of spaces then more letters — the longest prefix that fits at 8 chars
    // (56px, under the 68px room) lands inside the space run, which must not survive into the
    // truncated text as "AAAA    …".
    const label = `AAAA${' '.repeat(10)}CCCCCCCCCC`;
    const result = fitLabel(label, 80, 5, 120, measure);
    expect(result!.text).toBe(`AAAA${ELLIPSIS}`);
  });

  it('returns null instead of drawing when neither side has room for even a couple of characters', () => {
    // Node centred in a 30px canvas: both sides have exactly 3px of room, far under the ~21px
    // (ellipsis + 2 chars) floor — nothing legible would fit, so skip the label entirely.
    expect(fitLabel('Node', 15, 5, 30, measure)).toBeNull();
  });
});

describe('hoverLabelBox', () => {
  it('places a padded box to the right of the node when it fits there', () => {
    expect(hoverLabelBox('Softmax', 50, 8, 300, measure)).toEqual({ x: 61, width: 57, textX: 65 });
  });

  it('never truncates, unlike fitLabel, even under the exact geometry that forces fitLabel to cut the label', () => {
    const label = 'B'.repeat(40);
    const box = hoverLabelBox(label, 80, 5, 120, measure);
    // Full 40-char label plus padding, not the 8-char truncation fitLabel produces for these
    // same inputs (see the fitLabel truncation test above).
    expect(box.width).toBe(measure(label) + 8);
  });

  it('clamps to stay within [0, canvasWidth] when neither side fits, without shrinking the label', () => {
    // Node centred in a 100px canvas; the 78px box (70px label + padding) fits neither the right
    // (only 42px of room past the node) nor the left (only 42px before it), so it clamps.
    const box = hoverLabelBox('Ten Chars!', 50, 5, 100, measure);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(100);
    expect(box.width).toBe(measure('Ten Chars!') + 8);
    expect(box).toEqual({ x: 22, width: 78, textX: 26 });
  });
});
