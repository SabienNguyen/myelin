import { describe, it, expect } from 'vitest';
import { buildBootstrapContext, buildInstructions } from '../src/server/prompt.js';

describe('prompt assembly', () => {
  it('instructions include the evidence rule', () => {
    expect(buildInstructions()).toMatch(/record_evidence/);
  });
  it('bootstrap context includes lessons, mode framing, and anki lapses', () => {
    const ctx = buildBootstrapContext({
      mode: 'review',
      state: { 'chain-rule': { level: 'practicing' } },
      lessons: [{ slug: 'derivatives', title: 'Derivatives', reason: 'review-due', detail: 'decayed' }],
      reviewsDue: ['derivatives'],
      ankiLapses: [{ slug: 'chain-rule', count: 3 }],
    });
    expect(ctx).toMatch(/SESSION CONTEXT/);
    expect(ctx).toMatch(/review/i);
    expect(ctx).toMatch(/derivatives/);
    expect(ctx).toMatch(/chain-rule.*3 lapses/);
  });
});
