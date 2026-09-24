import { describe, it, expect } from 'vitest';
import { planWithin, type PlanItem } from '../../src/client/components/Thread.js';

const row = (slug: string, covers?: string[]): PlanItem => ({ kind: covers ? 'quiz' : 'review', slug, title: slug, why: 'due', ...(covers ? { covers } : {}) });
const topics = (...slugs: string[]) => slugs.map((slug) => ({ slug, title: slug.toUpperCase() }));

describe('planWithin', () => {
  it('keeps the notebook’s rows in order and drops the rest', () => {
    const plan = [row('chain-rule'), row('alkanes'), row('limits')];
    expect(planWithin(plan, topics('limits', 'chain-rule')).map((p) => p.slug)).toEqual(['chain-rule', 'limits']);
  });

  it('keeps a quiz row whose pages are all in the notebook as it is, and drops one with none', () => {
    const plan = [row('limits', ['limits', 'chain-rule']), row('alkanes', ['alkanes'])];
    expect(planWithin(plan, topics('limits', 'chain-rule'))).toEqual([row('limits', ['limits', 'chain-rule'])]);
  });

  it('renames a narrowed quiz after its first in-scope page and names only in-scope pages', () => {
    const plan = [{ ...row('alkanes', ['alkanes', 'limits', 'chain-rule']), title: 'Alkanes', why: '3 of your due pages, quizzed together: alkanes, limits, chain-rule' }];
    expect(planWithin(plan, topics('limits', 'chain-rule'))).toEqual([{
      kind: 'quiz', slug: 'limits', title: 'LIMITS', covers: ['limits', 'chain-rule'],
      why: '2 of your due pages, quizzed together: limits, chain-rule',
    }]);
  });

  it('turns a quiz narrowed to one page into a review of that page', () => {
    const plan = [{ ...row('alkanes', ['alkanes', 'limits']), transfer: 'probe in a new context' }];
    expect(planWithin(plan, topics('limits'))).toEqual([
      { kind: 'review', slug: 'limits', title: 'LIMITS', why: 'due for review', transfer: 'probe in a new context' },
    ]);
  });
});
