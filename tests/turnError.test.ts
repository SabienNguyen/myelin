import { describe, it, expect } from 'vitest';
import { explainTurnError } from '../src/server/turnError.js';

// Verbatim from a live Groq free-tier turn: the tutor's system prompt alone is ~8,100 tokens, so
// the full agentic request can never fit an 8,000 tokens-per-minute budget.
const GROQ = 'Request too large for model `openai/gpt-oss-120b` in organization `org_01abc` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 11417, please reduce your message size and try again.';

describe('explainTurnError', () => {
  it('turns a per-minute size refusal into the numbers, the consequence and the fix', () => {
    const out = explainTurnError(new Error(GROQ));
    expect(out).toContain('11,417');
    expect(out).toContain('8,000');
    expect(out).toMatch(/retrying will not help/);
    expect(out).toMatch(/rails/);
    expect(out).not.toContain('org_01abc'); // an account id has no place in the transcript
  });

  it('leaves an ordinary rate limit alone — that one DOES clear by waiting', () => {
    const out = explainTurnError(new Error('Rate limit reached on tokens per minute (TPM): Limit 8000, Used 7900, Requested 600. Please try again in 3.7s.'));
    expect(out).toMatch(/^The tutor hit an error and this turn was lost: Rate limit reached/);
  });

  it('keeps every other error as it was, truncated', () => {
    expect(explainTurnError(new Error('x'.repeat(500)))).toBe(`The tutor hit an error and this turn was lost: ${'x'.repeat(200)}`);
    expect(explainTurnError('plain string')).toBe('The tutor hit an error and this turn was lost: plain string');
  });
});
