// Minimal port of ~/Dev/personal/the-gap apps/web/test/failureMessages.test.ts's tone-and-proximity
// assertions (READ ONLY there) — runs the real ported strings in
// src/client/components/blocks/gap/{failureMessages,handWrittenProse,WorkedExample}.ts through the
// ported assertToneClean (./tone.ts), matching docs/superpowers/plans/2026-07-20-gap-integration.md
// I2's "assertToneClean equivalent: no praise strings in ported failureMessages" requirement.
import { describe, expect, it } from 'vitest';
import { assertToneClean } from '../../../src/client/components/blocks/gap/tone.js';
import { streamConsumerMessages, proximityMessage, testPredicate } from '../../../src/client/components/blocks/gap/failureMessages.js';
import { ALL_HAND_WRITTEN_PROSE } from '../../../src/client/components/blocks/gap/handWrittenProse.js';
import { WRONG_PICK_NOTE } from '../../../src/client/components/blocks/gap/WorkedExample.js';
import { OFFER_LABEL } from '../../../src/client/components/blocks/gap/OfferPanel.js';

describe('streamConsumerMessages (tone)', () => {
  it('has at least 6 hand-written rules', () => {
    expect(streamConsumerMessages.length).toBeGreaterThanOrEqual(6);
  });

  it('every message passes assertToneClean (no praise, no emoji, no exclamation-heavy prose)', () => {
    for (const rule of streamConsumerMessages) {
      expect(() => assertToneClean(rule.message)).not.toThrow();
    }
  });

  it('no message contains an exclamation mark at all (stricter than the shared assertToneClean floor)', () => {
    for (const rule of streamConsumerMessages) {
      expect(rule.message).not.toMatch(/!/);
    }
  });

  it('messages name what is left, never the fix — no code-shaped tokens like "===" or "return"', () => {
    for (const rule of streamConsumerMessages) {
      expect(rule.message).not.toMatch(/===|function |=>|;\s*$/);
    }
  });
});

describe('proximityMessage', () => {
  it('returns empty string for an empty failing set', () => {
    expect(proximityMessage(new Set())).toBe('');
  });

  it('names the null-body gap first when that test is failing', () => {
    const failing = new Set([
      'consumeStream calls onError and returns early when response.body is null, without touching a reader',
    ]);
    expect(proximityMessage(failing)).toBe('nothing handles a null body yet');
  });

  // Was: a bare count ("1 tests still failing — read their names in the panel.", pluralisation bug
  // included). Any artifact without a hand-written rule set above — i.e. every artifact but one —
  // got no information at all, which is the bottleneck that stops the coding path scaling. The
  // fallback now DERIVES a message from the suite's own test names.
  it('derives a message from the failing test names when no rule matches', () => {
    expect(proximityMessage(new Set(['some future test name not covered by any rule'])))
      .toBe('still to handle: some future test name not covered by any rule.');
  });
  it('strips a camelCase subject but keeps a lowercase opening verb', () => {
    expect(testPredicate('consumeStream reassembles a split line')).toBe('reassembles a split line');
    expect(testPredicate('parseSSE flushes the tail')).toBe('flushes the tail');
    expect(testPredicate('handles a null body')).toBe('handles a null body'); // verb, not a subject
  });
  it('summarises two and more-than-two failing tests', () => {
    expect(proximityMessage(new Set(['aFn does x', 'bFn does y'])))
      .toBe('still to handle: does x; and does y.');
    const three = proximityMessage(new Set(['aFn does x', 'bFn does y', 'cFn does z']));
    expect(three).toBe('still to handle: does x; and 2 more.');
  });
  it('derived messages are tone-clean like the hand-written ones', () => {
    const msg = proximityMessage(new Set(['aFn does x', 'bFn does y']));
    expect(() => assertToneClean(msg)).not.toThrow();
  });

  it('first match wins: null-body rule fires even when other tests are also failing', () => {
    const failing = new Set([
      'consumeStream calls onError and returns early when response.body is null, without touching a reader',
      'consumeStream emits onToken in order for well-formed SSE lines, one chunk per line',
    ]);
    expect(proximityMessage(failing)).toBe('nothing handles a null body yet');
  });
});

describe('the rest of the ported prose is tone-clean', () => {
  it('has at least one hand-written prose string to check', () => {
    expect(ALL_HAND_WRITTEN_PROSE.length).toBeGreaterThan(0);
  });
  it.each(ALL_HAND_WRITTEN_PROSE.map((text, i) => [i, text] as const))(
    'handWrittenProse string %i is tone-clean',
    (_i, text) => { expect(() => assertToneClean(text)).not.toThrow(); },
  );
  it("WorkedExample's wrong-pick note is tone-clean", () => {
    expect(() => assertToneClean(WRONG_PICK_NOTE)).not.toThrow();
  });
  it('the ambient offer label is tone-clean', () => {
    expect(() => assertToneClean(OFFER_LABEL)).not.toThrow();
  });
});
