import { describe, it, expect } from 'vitest';
import { layoutGraph } from '../../src/client/lib/graphLayout.js';

const nodes = [
  { slug: 'derivatives', title: 'Derivatives', prereqs: [], deepens: [],
    mastery: { level: 'mastered', effective: 'mastered', last_reinforced: '2026-07-05', evidence: [], misconceptions: [] } },
  { slug: 'chain-rule', title: 'Chain Rule', prereqs: ['derivatives'], deepens: [],
    mastery: { level: 'practicing', effective: 'exposed', last_reinforced: '2026-05-01', evidence: [], misconceptions: ['order confusion'] } },
  { slug: 'jacobians', title: 'Jacobians', prereqs: [], deepens: ['chain-rule'], mastery: null },
];

describe('layoutGraph', () => {
  const g = layoutGraph(nodes as any, new Date('2026-07-12'));
  it('colors by EFFECTIVE level', () => {
    expect(g.nodes.find((n) => n.slug === 'chain-rule')!.color).toBe('#e0b040'); // effective exposed, not stored practicing
  });
  it('computes decay ring for mastered (7 of 45 days elapsed)', () => {
    const d = g.nodes.find((n) => n.slug === 'derivatives')!;
    expect(d.daysLeft).toBe(38);
    expect(d.ringFraction).toBeCloseTo(38 / 45, 2);
  });
  it('positions prereq below dependent (larger y = earlier)', () => {
    const dep = g.nodes.find((n) => n.slug === 'derivatives')!;
    const chain = g.nodes.find((n) => n.slug === 'chain-rule')!;
    expect(dep.y).toBeGreaterThan(chain.y);
  });
  it('null mastery renders unseen gray, no ring', () => {
    const j = g.nodes.find((n) => n.slug === 'jacobians')!;
    expect(j.color).toBe('#9e9e9e');
    expect(j.ringFraction).toBeNull();
  });
});
