import { describe, it, expect } from 'vitest';
import { BLOCK_TOOLS, BLOCK_TOOL_NAMES } from '../src/shared/blocks.js';

describe('block schemas', () => {
  it('exposes exactly the four v1 kinds', () => {
    expect(BLOCK_TOOL_NAMES.sort()).toEqual(['math_scratchpad', 'quick_check', 'quiz', 'writing_draft']);
  });
  it('quick_check round-trips', () => {
    const input = { question: '2+2?', mode: 'choice', choices: ['3', '4'], pageSlug: 'arith' };
    expect(BLOCK_TOOLS.quick_check.input.parse(input)).toEqual(input);
    expect(BLOCK_TOOLS.quick_check.result.parse({ answer: '4' })).toEqual({ answer: '4' });
  });
  it('math_scratchpad requires problemLatex', () => {
    expect(() => BLOCK_TOOLS.math_scratchpad.input.parse({ stepMode: true })).toThrow();
  });
});
