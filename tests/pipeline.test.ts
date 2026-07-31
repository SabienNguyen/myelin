import { describe, it, expect } from 'vitest';
import { budgetChars, classifyFailure, isTransportFailure } from '../src/server/pipeline.js';
import { LlmHttpError } from '../src/server/llm/index.js';

describe('budgetChars', () => {
  it('derives a char budget from contextTokens with scaffold headroom', () => {
    // tokens*4 chars minus 8k scaffold reserve (system + schema + instructions)
    expect(budgetChars(32_768)).toBe(32_768 * 4 - 8_000);
  });
  it('falls back to the proven CHAPTER_CHUNK_CHARS default when unset', () => {
    expect(budgetChars(undefined)).toBe(24_000);
  });
  it('never returns less than 4k chars even for a tiny window', () => {
    expect(budgetChars(1_000)).toBe(4_000);
  });
});

describe('classifyFailure', () => {
  it('transport: LlmHttpError and undici fetch-failed', () => {
    expect(classifyFailure(new LlmHttpError('ollama', 503, 'boom'), 10, 100)).toBe('transport');
    expect(classifyFailure(new TypeError('fetch failed'), 10, 100)).toBe('transport');
  });
  it('overflow: the prompt did not fit the budget', () => {
    expect(classifyFailure(new Error('schema rejected'), 200, 100)).toBe('overflow');
  });
  it('weak-output: it fit, the model still failed', () => {
    expect(classifyFailure(new Error('schema rejected'), 50, 100)).toBe('weak-output');
  });
});
