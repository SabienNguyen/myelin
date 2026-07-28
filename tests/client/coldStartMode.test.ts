import { describe, it, expect } from 'vitest';
import { coldStartMode } from '../../src/client/lib/coldStartMode.js';

// The cold-start audit: a brand-new vault opened in `learn`, whose single-writer rule forbids
// write_page — the newcomer's first lesson was researched, taught, and then evaporated. The
// session should open in the one mode that can keep the empty-state's "writes pages as you go"
// promise, and flip back to `learn` as soon as anything real exists to be grounded in.
describe('coldStartMode — a vault with nothing teachable opens in freeform', () => {
  it('empty graph → freeform', () => {
    expect(coldStartMode([])).toBe('freeform');
  });

  it('only stubs (boot-seeded pattern page, auto-created prereqs) → freeform', () => {
    expect(coldStartMode([{ status: 'stub' }, { status: 'stub' }])).toBe('freeform');
  });

  it('any real page → learn', () => {
    expect(coldStartMode([{ status: 'stub' }, { status: 'solid' }])).toBe('learn');
    expect(coldStartMode([{ status: 'researched' }])).toBe('learn');
  });

  it('a node with no status at all counts as real — only an explicit stub is a placeholder', () => {
    expect(coldStartMode([{}])).toBe('learn');
  });
});
