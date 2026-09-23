import { describe, it, expect } from 'vitest';
import { planWithin, type PlanItem } from '../../src/client/components/Thread.js';

const row = (slug: string, covers?: string[]): PlanItem => ({ kind: covers ? 'quiz' : 'review', slug, title: slug, why: 'due', ...(covers ? { covers } : {}) });

describe('planWithin', () => {
  it('keeps the notebook’s rows in order and drops the rest', () => {
    const plan = [row('chain-rule'), row('alkanes'), row('limits')];
    expect(planWithin(plan, ['limits', 'chain-rule']).map((p) => p.slug)).toEqual(['chain-rule', 'limits']);
  });
  it('narrows a quiz row to the pages it covers inside the notebook, and drops it when none are', () => {
    const plan = [row('quiz-1', ['limits', 'alkanes', 'chain-rule']), row('quiz-2', ['alkanes'])];
    expect(planWithin(plan, ['limits', 'chain-rule'])).toEqual([row('quiz-1', ['limits', 'chain-rule'])]);
  });
});
