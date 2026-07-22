import { describe, it, expect } from 'vitest';
import { graphMeta, radiusForDegree, NODE_R_MIN } from '../../src/client/lib/graphLayout.js';

const nodes = [
  { slug: 'derivatives', title: 'Derivatives', prereqs: [], deepens: [],
    mastery: { level: 'mastered', effective: 'mastered', last_reinforced: '2026-07-05', evidence: [], misconceptions: [] } },
  { slug: 'chain-rule', title: 'Chain Rule', prereqs: ['derivatives'], deepens: [],
    mastery: { level: 'practicing', effective: 'exposed', last_reinforced: '2026-05-01', evidence: [], misconceptions: ['order confusion'] } },
  { slug: 'jacobians', title: 'Jacobians', prereqs: [], deepens: ['chain-rule'], mastery: null },
];

describe('graphMeta', () => {
  const g = graphMeta(nodes as any, new Date('2026-07-12'));
  it('colors by EFFECTIVE level', () => {
    expect(g.nodes.find((n) => n.slug === 'chain-rule')!.color).toBe('#e0b040'); // effective exposed, not stored practicing
  });
  it('computes decay ring for mastered (7 of 45 days elapsed)', () => {
    const d = g.nodes.find((n) => n.slug === 'derivatives')!;
    expect(d.daysLeft).toBe(38);
    expect(d.ringFraction).toBeCloseTo(38 / 45, 2);
  });
  it('null mastery renders unseen gray, no ring', () => {
    const j = g.nodes.find((n) => n.slug === 'jacobians')!;
    expect(j.color).toBe('#9e9e9e');
    expect(j.ringFraction).toBeNull();
  });
  it('computes degree as the count of prereq+deepens edges touching each node, either direction', () => {
    // edges: chain-rule -> derivatives (prereq), jacobians -> chain-rule (deepens).
    expect(g.nodes.find((n) => n.slug === 'derivatives')!.degree).toBe(1);
    expect(g.nodes.find((n) => n.slug === 'chain-rule')!.degree).toBe(2); // touches both edges
    expect(g.nodes.find((n) => n.slug === 'jacobians')!.degree).toBe(1);
  });
  it('a node with no prereqs/deepens and nothing pointing at it has degree 0', () => {
    const solo = graphMeta(
      [{ slug: 'solo', title: 'Solo', prereqs: [], deepens: [], mastery: null }] as any, new Date(),
    );
    expect(solo.nodes[0].degree).toBe(0);
  });
});

describe('graphMeta with disconnected domains', () => {
  const disconnected = [
    { slug: 'algebra-a', title: 'Algebra A', prereqs: [], deepens: [], mastery: null },
    { slug: 'algebra-b', title: 'Algebra B', prereqs: ['algebra-a'], deepens: [], mastery: null },
    { slug: 'history-a', title: 'History A', prereqs: [], deepens: [], mastery: null },
    { slug: 'history-b', title: 'History B', prereqs: ['history-a'], deepens: [], mastery: null },
  ];

  it('computes metadata for two disconnected components without crashing', () => {
    expect(() => graphMeta(disconnected as any, new Date('2026-07-12'))).not.toThrow();
  });
});

// radiusForDegree drives GraphPanel's Obsidian-style "more links = bigger node" sizing. Pure and
// unit-testable without a DOM or a running d3-force simulation.
describe('radiusForDegree', () => {
  it('a degree-0 node gets the minimum radius', () => {
    expect(radiusForDegree(0)).toBe(NODE_R_MIN);
  });
  it('grows monotonically with degree', () => {
    expect(radiusForDegree(1)).toBeGreaterThan(radiusForDegree(0));
    expect(radiusForDegree(5)).toBeGreaterThan(radiusForDegree(1));
    expect(radiusForDegree(20)).toBeGreaterThan(radiusForDegree(5));
  });
  it('grows with diminishing returns per extra link, so a handful of hub nodes never dwarf everything else', () => {
    const deltaLow = radiusForDegree(2) - radiusForDegree(1);
    const deltaHigh = radiusForDegree(21) - radiusForDegree(20);
    expect(deltaHigh).toBeLessThan(deltaLow);
  });
});
