// Weak-model regression suite: the REAL rails generation path (generateRailsQuickCheck /
// generateRailsFeedback — real prompts, real schemas, real retry-then-fallback semantics) driven
// against a deliberately weak "7B-class" model (tests/fixtures/weakModel.ts). The standing
// contract under test: whatever a small model does — fenced JSON, truncation, expected∉choices,
// prose refusals, response_format rejection, mangled tool arguments — the harness NEVER throws at
// the caller; every trial lands on a valid object or the documented deterministic fallback.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openaiCompatModel, resetResponseFormatMemory } from '../../src/server/llm/openaiCompat.js';
import {
  generateRailsFeedback, generateRailsQuickCheck, railsCheckSchema, type RailsItem,
} from '../../src/server/rails.js';
import type { HarnessConfig } from '../../src/server/config.js';
import type { Grade } from '../../src/server/grading.js';
import { startWeakModel, type WeakModelServer } from '../fixtures/weakModel.js';

// vault: '' → recordUsage no-ops (its documented test-fixture path); the rest is what the rails
// generation actually reads.
const cfg = { vault: '', student: 'weak-test', models: { tutor: { model: 'openai:weak-7b' } } } as
  unknown as HarnessConfig;

const item = (slug: string): RailsItem => ({ slug, title: `Page ${slug}`, level: 'unseen', reason: 'lesson' });
const page = { title: 'Bayes’ theorem', body: '# Bayes’ theorem\n\nP(A|B) = P(B|A)P(A)/P(B).' };
const FALLBACK_PREFIX = 'Which of these lines is from';

let weak: WeakModelServer;
afterEach(async () => { await weak.close(); });
beforeEach(() => { resetResponseFormatMemory(); });

describe('weak model: pathology cycle through the real rails path', () => {
  it('six trials absorb every failure mode — valid object or template fallback, never a throw', async () => {
    weak = await startWeakModel('pathology');
    const model = openaiCompatModel({ modelId: 'weak-7b', baseUrl: weak.baseUrl });

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await generateRailsQuickCheck({ model, cfg }, item(`p${i}`), page, [], []));
    }

    // Every result is schema-valid with expected among choices — the invariant rails' consumers
    // (BLOCK_TOOLS validation, the grader) rely on.
    for (const r of results) {
      railsCheckSchema.parse(r);
      expect(r.choices).toContain(r.expected);
    }
    // The cycle is built so the six trials land exactly: first, retry, fallback,
    // violation-then-retry, fallback, first — pinned by which results are the template.
    const fallbacks = results.map((r) => r.question.startsWith(FALLBACK_PREFIX));
    expect(fallbacks).toEqual([false, false, true, false, true, false]);
    // 10 model calls for 6 trials: the retries actually happened rather than first-try luck.
    expect(weak.calls()).toBe(10);
  });

  it('feedback: prose refusal lands on the machine-grade fallback, never a throw', async () => {
    weak = await startWeakModel('pathology');
    const model = openaiCompatModel({ modelId: 'weak-7b', baseUrl: weak.baseUrl });
    const graded = [{
      question: 'Which is the prior?', answer: 'P(A)',
      grade: {
        verdict: 'correct', source: 'mechanical', detail: 'matched expected', evidence: [],
      } as unknown as Grade,
    }];

    const first = await generateRailsFeedback({ model, cfg }, graded);
    expect(first.next).toBe('continue'); // cycle entry 1: valid
    const second = await generateRailsFeedback({ model, cfg }, graded);
    // Cycle entry 2 is chatty prose: the deterministic fallback reads the machine grade out loud.
    expect(second.feedback).toContain('machine grade: correct');
    expect(second.next).toBe('stop-offer');
  });
});

describe('weak model: response_format rejection and endpoint memory', () => {
  it('pays the rejected round-trip once, then every trial runs forced-tool — mangled args recovered by the rails retry', async () => {
    weak = await startWeakModel('reject-rf');
    const model = openaiCompatModel({ modelId: 'weak-7b', baseUrl: weak.baseUrl });

    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await generateRailsQuickCheck({ model, cfg }, item(`p${i}`), page, [], []));
    }

    for (const r of results) {
      railsCheckSchema.parse(r);
      expect(r.choices).toContain(r.expected);
      // No trial should have needed the template: the tool path serves valid objects except the
      // one mangled-arguments call, which the rails retry recovers.
      expect(r.question.startsWith(FALLBACK_PREFIX)).toBe(false);
    }
    // THE memory assertion: exactly one request ever carried response_format — the first. Every
    // later structured generation skipped straight to the forced-tool form.
    expect(weak.rfRequests()).toBe(1);
    // 1 rejected rf + 5 tool calls (4 trials + 1 retry of the mangled second tool call).
    expect(weak.calls()).toBe(6);
  });
});
