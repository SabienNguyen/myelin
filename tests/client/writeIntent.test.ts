import { describe, it, expect } from 'vitest';
import { armWriteIntent, consumeWriteIntent } from '../../src/client/lib/writeIntent.js';

// The one-shot "write this up" latch (writeIntent.ts): the OfferWrite button arms it just before
// one send, the transport consumes it into that single request's body, and it must NOT leak into
// any later send — that's what keeps the freeform promotion scoped to exactly the write turn.
describe('writeIntent — a one-shot latch that a stray later send cannot inherit', () => {
  it('defaults to false', () => {
    // Nothing armed yet in a fresh read (consume also clears any prior test's arming).
    consumeWriteIntent();
    expect(consumeWriteIntent()).toBe(false);
  });

  it('arm → consume returns true exactly once, then reverts to false', () => {
    armWriteIntent();
    expect(consumeWriteIntent()).toBe(true);
    expect(consumeWriteIntent()).toBe(false);
  });

  it('re-arming works after a consume', () => {
    armWriteIntent();
    consumeWriteIntent();
    armWriteIntent();
    expect(consumeWriteIntent()).toBe(true);
  });
});
