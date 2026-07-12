import { describe, it, expect } from 'vitest';
import { modelFor, cachedSystem } from '../src/server/models.js';

const cfg = { models: { tutor: { model: 'claude-sonnet-5' }, grader: { model: 'claude-haiku-4-5' } } } as any;

describe('model router', () => {
  it('routes roles to configured ids', () => {
    expect(modelFor('tutor', cfg).modelId).toBe('claude-sonnet-5');
    expect(modelFor('grader', cfg).modelId).toBe('claude-haiku-4-5');
  });
  it('marks system message for anthropic caching', () => {
    const m = cachedSystem('be a tutor');
    expect(m.role).toBe('system');
    expect((m as any).providerOptions.anthropic.cacheControl.type).toBe('ephemeral');
  });
});
