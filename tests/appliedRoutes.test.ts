// Which applied route could confirm a page — derived, never a subject registry. These pin both the
// derivations and the one honest "does not exist" case.

import { describe, it, expect } from 'vitest';
import { appliedRoutesFor, missingLadder } from '../src/server/appliedRoutes.js';

const PATTERNS = ['stream-consumer'];

describe('appliedRoutesFor', () => {
  it('a ladder page leads with the code exercise', () => {
    const routes = appliedRoutesFor({ slug: 'stream-consumer', body: 'buffering' }, PATTERNS);
    expect(routes[0].block).toBe('code_exercise');
  });

  it('a page whose body carries notation gets the scratchpad — derived from content, not domain', () => {
    const routes = appliedRoutesFor({ slug: 'derivatives', body: 'The slope $\\frac{dy}{dx}$ at a point.' }, PATTERNS);
    expect(routes[0].block).toBe('math_scratchpad');
  });

  it('every page has structured_check, so "no applied route" is never claimed falsely', () => {
    const routes = appliedRoutesFor({ slug: 'consideration-in-contract-law', body: 'prose only' }, PATTERNS);
    expect(routes.map((r) => r.block)).toContain('structured_check');
  });

  it('the rubric route comes LAST — it caps below mastered and must not undersell the others', () => {
    const routes = appliedRoutesFor({ slug: 'anything', body: 'x' }, PATTERNS);
    expect(routes[routes.length - 1].block).toBe('writing_draft');
    expect(routes[routes.length - 1].why).toMatch(/capped below mastered/);
  });
});

describe('missingLadder — the one honest "does not exist yet"', () => {
  it('true for a programming page with no ladder', () => {
    expect(missingLadder({ slug: 'debounce', domain: 'programming' }, PATTERNS)).toBe(true);
  });
  it('false for the pattern that HAS a ladder, and for non-programming pages', () => {
    expect(missingLadder({ slug: 'stream-consumer', domain: 'programming' }, PATTERNS)).toBe(false);
    expect(missingLadder({ slug: 'derivatives', domain: 'math' }, PATTERNS)).toBe(false);
  });
});
