import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8');
const luminance = (hex: string) => {
  const rgb = hex.match(/[a-f0-9]{2}/gi)!.map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
};
describe('workspace design tokens', () => {
  it('uses a dark default and a three-step radius scale that steps down as surfaces nest', () => {
    const root = css.match(/:root\s*\{([^}]+)\}/)![1];
    expect(root).toMatch(/color-scheme:\s*dark/);
    const px = (name: string) => Number(root.match(new RegExp(`--${name}:\\s*(\\d+)px`))![1]);
    // Shell (canvas, composer, popovers) > cards and bubbles > controls. A control rounder than
    // the card it sits in, or a card rounder than the canvas, is how nested corners look wrong.
    expect(px('radius-shell')).toBeGreaterThan(px('radius'));
    expect(px('radius')).toBeGreaterThan(px('radius-sm'));
    expect(px('radius-sm')).toBeGreaterThanOrEqual(6); // 2px corners read as boxy — tried, rejected
  });
  it('keeps text and verdicts AA on every neutral surface in each palette', () => {
    const roots = [...css.matchAll(/:root\s*\{([^}]+)\}/g)].filter(([, body]) => /--bg:/.test(body));
    expect(roots.length).toBe(2);
    for (const [, root] of roots) {
      const tokens = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[a-f0-9]{6})/gi)].map(m => [m[1], m[2]]));
      for (const fg of ['text','text-muted','good','bad','warn','accent']) for (const bg of ['bg','bg-panel','bg-inset']) {
        const a = luminance(tokens[fg]); const b = luminance(tokens[bg]);
        expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
