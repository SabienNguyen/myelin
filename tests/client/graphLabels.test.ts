import { describe, it, expect } from 'vitest';
import { fitLabel, placeHoverBox } from '../../src/client/graph/labels.js';

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

describe('placeHoverBox', () => {
  it('anchors on the right, unshifted, when the box fits there', () => {
    // Node at x=100 in a 600px canvas, box reaching 80px further out: right edge lands at 180,
    // well clear of the 596px margin.
    expect(placeHoverBox(100, 80, 600)).toEqual({ align: 'right', x: 100 });
  });

  it('flips to the left, unshifted, when the right side lacks room but the left has it', () => {
    // Node 30px from the right edge of a 200px canvas — an 80px box overshoots on the right
    // (30+80 > 196) but comfortably clears on the left (170-80 >= 4).
    expect(placeHoverBox(170, 80, 200)).toEqual({ align: 'left', x: 170 });
  });

  it('clamps inside the canvas, sliding toward the roomier side, when neither side fits', () => {
    // Node dead centre of a narrow 100px canvas with a 90px box: right overshoots (50+90 > 96)
    // and left overshoots too (50-90 < 4) — room is tied, so it slides right (this function's tie
    // break) just far enough that the box's far edge lands exactly on the canvas margin.
    const placement = placeHoverBox(50, 90, 100);
    expect(placement.align).toBe('right');
    expect(placement.x).toBe(6); // 100 - 4 - 90
    expect(placement.x + 90).toBeLessThanOrEqual(96);
    expect(placement.x).toBeGreaterThanOrEqual(0);
  });

  it('never reports a placement whose anchor falls outside the canvas', () => {
    // A box wider than the whole canvas: even clamped, the anchor itself must stay in [0, width].
    const placement = placeHoverBox(10, 500, 100);
    expect(placement.x).toBeGreaterThanOrEqual(0);
    expect(placement.x).toBeLessThanOrEqual(100);
  });
});
