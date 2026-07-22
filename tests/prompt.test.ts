import { describe, it, expect } from 'vitest';
import { buildBootstrapContext, buildInstructions } from '../src/server/prompt.js';

describe('prompt assembly', () => {
  it('instructions include the evidence rule', () => {
    expect(buildInstructions()).toMatch(/record_evidence/);
  });
  it('instructions forbid narrating block mechanics after a block tool call (docs/superpowers/'
    + 'plans/2026-07-21-coding-stage.md section C)', () => {
    const instructions = buildInstructions();
    expect(instructions).toMatch(/do not narrate block mechanics/i);
    expect(instructions).toMatch(/The\s+block is displayed/);
    expect(instructions).toMatch(/at most one sentence of NEW\s+pedagogical content/i);
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
