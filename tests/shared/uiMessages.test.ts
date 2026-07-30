import { describe, it, expect } from 'vitest';
import {
  getToolName, isDataUIPart, isToolUIPart, type UIPart,
} from '../../src/shared/uiMessages.js';

describe('uiMessages helpers', () => {
  it('isToolUIPart matches tool-* parts only', () => {
    const tool: UIPart = { type: 'tool-quick_check', toolCallId: 'tc1', state: 'input-available' };
    expect(isToolUIPart(tool)).toBe(true);
    expect(isToolUIPart({ type: 'text', text: 'x' })).toBe(false);
    expect(isToolUIPart({ type: 'step-start' })).toBe(false);
    expect(isToolUIPart({ type: 'data-guardrail', data: {} })).toBe(false);
  });

  it('isDataUIPart matches data-* parts only', () => {
    expect(isDataUIPart({ type: 'data-guardrail', data: {} })).toBe(true);
    expect(isDataUIPart({ type: 'text', text: 'x' })).toBe(false);
    expect(isDataUIPart({ type: 'tool-quiz', toolCallId: 't', state: 'input-available' })).toBe(false);
  });

  it('getToolName inverts the part-type prefix, keeping inner hyphens and underscores', () => {
    expect(getToolName({ type: 'tool-quick_check', toolCallId: 't', state: 'input-available' })).toBe('quick_check');
    expect(getToolName({ type: 'tool-find-analogies', toolCallId: 't', state: 'input-available' })).toBe('find-analogies');
  });
});
