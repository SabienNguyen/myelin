import { describe, it, expect } from 'vitest';
import { dedupeById } from '../src/shared/messages.js';

describe('dedupeById', () => {
  it('returns [] for an empty array', () => {
    expect(dedupeById([])).toEqual([]);
  });

  it('is the identity when there are no duplicate ids', () => {
    const messages = [{ id: 'a', text: '1' }, { id: 'b', text: '2' }, { id: 'c', text: '3' }];
    expect(dedupeById(messages)).toEqual(messages);
  });

  it('keeps messages without a string id as-is, never dropping them', () => {
    const messages = [{ id: 'a' }, { note: 'no id field' }, { id: 42 }, { id: null }];
    expect(dedupeById(messages)).toEqual(messages);
  });

  it('drops earlier duplicates by id, keeping the LAST occurrence, preserving survivor order', () => {
    const messages = [
      { id: 'a', v: 'first-a' },
      { id: 'b', v: 'only-b' },
      { id: 'a', v: 'second-a' }, // more complete re-persist of 'a'
    ];
    expect(dedupeById(messages)).toEqual([
      { id: 'b', v: 'only-b' },
      { id: 'a', v: 'second-a' },
    ]);
  });
});
