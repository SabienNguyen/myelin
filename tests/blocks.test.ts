import { describe, it, expect } from 'vitest';
import { BLOCK_TOOLS, BLOCK_TOOL_NAMES } from '../src/shared/blocks.js';

describe('block schemas', () => {
  it('exposes exactly the five v1 kinds', () => {
    expect(BLOCK_TOOL_NAMES.sort()).toEqual(
      ['code_exercise', 'math_scratchpad', 'quick_check', 'quiz', 'writing_draft'],
    );
  });
  it('quick_check round-trips', () => {
    const input = { question: '2+2?', mode: 'choice', choices: ['3', '4'], pageSlug: 'arith' };
    expect(BLOCK_TOOLS.quick_check.input.parse(input)).toEqual(input);
    expect(BLOCK_TOOLS.quick_check.result.parse({ answer: '4' })).toEqual({ answer: '4' });
  });
  it('math_scratchpad requires problemLatex', () => {
    expect(() => BLOCK_TOOLS.math_scratchpad.input.parse({ stepMode: true })).toThrow();
  });
  it('code_exercise round-trips', () => {
    const input = { pattern: 'stream-consumer', rung: 'ladder', pageSlug: 'stream-consumer' };
    expect(BLOCK_TOOLS.code_exercise.input.parse(input)).toEqual(input);
    const result = { completed: true, rungReached: 'full_body', testsPassed: 8, testsTotal: 8, wroteCode: true };
    expect(BLOCK_TOOLS.code_exercise.result.parse(result)).toEqual(result);
  });
  it('code_exercise rejects an unknown rung value', () => {
    expect(() => BLOCK_TOOLS.code_exercise.input.parse(
      { pattern: 'stream-consumer', rung: 'bogus', pageSlug: 'stream-consumer' },
    )).toThrow();
  });
});
