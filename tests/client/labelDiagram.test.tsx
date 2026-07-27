import { describe, it, expect } from 'vitest';
import { decodeEntityEscapedSvg, separatePins } from '../../src/client/components/blocks/LabelDiagram.js';

// A live sitting supplied two regions at coincident coordinates and one pin buried the other —
// visible but never clickable, so the exercise could not be completed by mouse.
describe('separatePins — model-supplied coordinates get a spacing guarantee', () => {
  it('nudges coincident pins apart past the minimum gap', () => {
    const out = separatePins([
      { id: 'a', x: 50, y: 40, label: 'A' },
      { id: 'b', x: 50, y: 40, label: 'B' },
      { id: 'c', x: 51, y: 41, label: 'C' },
    ]);
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
      expect(Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y)).toBeGreaterThanOrEqual(6);
    }
  });
  it('leaves well-spaced pins exactly where the model put them', () => {
    const regions = [
      { id: 'a', x: 20, y: 20, label: 'A' },
      { id: 'b', x: 80, y: 80, label: 'B' },
    ];
    expect(separatePins(regions)).toEqual(regions);
  });
  it('clamps off-canvas coordinates into the canvas', () => {
    const [r] = separatePins([{ id: 'a', x: 120, y: -5, label: 'A' }]);
    expect(r.x).toBeLessThanOrEqual(97);
    expect(r.y).toBeGreaterThanOrEqual(2);
  });
});

describe('decodeEntityEscapedSvg — a fully escaped SVG becomes markup again', () => {
  it('decodes the five XML entities, ampersand last', () => {
    const escaped = '&lt;svg viewBox=&quot;0 0 10 10&quot;&gt;&lt;text&gt;a &amp;amp; b&lt;/text&gt;&lt;/svg&gt;';
    expect(decodeEntityEscapedSvg(escaped)).toBe('<svg viewBox="0 0 10 10"><text>a &amp; b</text></svg>');
  });
  it('leaves valid SVG untouched', () => {
    const ok = '<svg viewBox="0 0 10 10"><rect width="5"/></svg>';
    expect(decodeEntityEscapedSvg(ok)).toBe(ok);
  });
});
