// Minimal port of ~/Dev/personal/the-gap apps/web/test/failureMessages.test.ts's tone-and-proximity
// assertions (READ ONLY there) — runs the real ported strings in
// src/client/components/blocks/gap/{failureMessages,handWrittenProse,WorkedExample}.ts through the
// ported assertToneClean (./tone.ts), matching docs/superpowers/plans/2026-07-20-gap-integration.md
// I2's "assertToneClean equivalent: no praise strings in ported failureMessages" requirement.
import { describe, expect, it } from 'vitest';
import { assertToneClean } from '../../../src/client/components/blocks/gap/tone.js';
import { streamConsumerMessages, proximityMessage } from '../../../src/client/components/blocks/gap/failureMessages.js';
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

  it('falls back to the generic count message for an unrecognized failing-test combination', () => {
    const failing = new Set(['some future test name not covered by any rule']);
    expect(proximityMessage(failing)).toBe('1 tests still failing — read their names in the panel.');
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
