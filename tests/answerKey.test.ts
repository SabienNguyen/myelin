// The grader's flow: it sees the QUESTION when it is staged and decides the answer while the
// learner is still thinking; when the reply arrives it compares the two and says how well they did.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseAnswerKey, prepareAnswerKey, takeAnswerKey, resetAnswerKeys, sameAnswer,
} from '../src/server/answerKey.js';
import { gradeBlockOutput } from '../src/server/grading.js';
import { textModel } from './mockModel.js';

const cfg = { vault: undefined, models: { grader: { model: 'test-grader' } } } as any;
const KEY_REPLY = 'ANSWER: a buffer carried across reads\nPOINTS:\n- bytes from one read are kept\n- they are joined with the next read';

beforeEach(() => resetAnswerKeys());

describe('parseAnswerKey', () => {
  it('reads the answer and its must-have points', () => {
    expect(parseAnswerKey(KEY_REPLY)).toEqual({
      answer: 'a buffer carried across reads',
      points: ['bytes from one read are kept', 'they are joined with the next read'],
    });
  });
  it('tolerates markdown emphasis, numbered points and no points at all', () => {
    expect(parseAnswerKey('**ANSWER:** 42\n**POINTS:**\n1. it is a number\n2) it is even')).toEqual({
      answer: '42', points: ['it is a number', 'it is even'],
    });
    expect(parseAnswerKey('Answer: Paris')).toEqual({ answer: 'Paris', points: [] });
  });
  it('returns null for a reply with no answer line, rather than inventing a key', () => {
    expect(parseAnswerKey('I would need more context to answer this.')).toBeNull();
  });
});

describe('prepareAnswerKey / takeAnswerKey', () => {
  it('asks the grader when the question is STAGED, before any reply exists', async () => {
    const { model, prompts } = textModel(KEY_REPLY);
    prepareAnswerKey('call-1', 'What lets a stream parser survive a split line?', cfg, { model });
    const key = await takeAnswerKey('call-1');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('What lets a stream parser survive a split line?');
    expect(prompts[0]).not.toMatch(/student answer/i); // there is no answer yet
    expect(key?.answer).toBe('a buffer carried across reads');
  });

  // The tutor wrote the question AND its `expected`, in one breath. An independent grader is the
  // check on that: it is shown the tutor's suggestion as a claim to verify, not as the truth.
  it('shows the tutor\'s suggested answer as something to check, not to trust', async () => {
    const { model, prompts } = textModel(KEY_REPLY);
    prepareAnswerKey('call-2', 'q?', cfg, { model }, 'a queue');
    await takeAnswerKey('call-2');
    expect(prompts[0]).toContain('a queue');
    expect(prompts[0]).toMatch(/do not trust|may be wrong|check/i);
  });

  it('asks once per question even if staging is reported twice', async () => {
    const { model, prompts } = textModel(KEY_REPLY);
    prepareAnswerKey('call-3', 'q?', cfg, { model });
    prepareAnswerKey('call-3', 'q?', cfg, { model });
    await takeAnswerKey('call-3');
    expect(prompts).toHaveLength(1);
  });

  it('a grader that fails or rambles yields no key — grading then falls back, it does not break', async () => {
    const down = textModel(() => { throw new Error('grader down'); });
    prepareAnswerKey('call-4', 'q?', cfg, { model: down.model });
    expect(await takeAnswerKey('call-4')).toBeNull();
    const rambling = textModel('Let me think about what a good answer might be...');
    prepareAnswerKey('call-5', 'q?', cfg, { model: rambling.model });
    expect(await takeAnswerKey('call-5')).toBeNull();
  });

  it('a key nobody prepared is null at once, and a slow one is not waited on forever', async () => {
    expect(await takeAnswerKey('never-staged')).toBeNull();
    const never = { async generate() { return new Promise(() => {}); } } as any;
    prepareAnswerKey('call-6', 'q?', cfg, { model: never });
    const t0 = Date.now();
    expect(await takeAnswerKey('call-6', 40)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('sameAnswer', () => {
  it.each([
    ['A buffer carried across reads.', 'a buffer carried across reads'],
    ['  the  Chain   rule ', 'The chain rule'],
    ['"Paris"', 'paris'],
  ])('%j is the same answer as %j', (a, b) => expect(sameAnswer(a, b)).toBe(true));
  it('a different answer is not', () => expect(sameAnswer('a queue', 'a buffer')).toBe(false));
});

describe('grading an open answer against the prepared key', () => {
  const input = { question: 'What lets a stream parser survive a split line?', mode: 'text', pageSlug: 'streams' };

  it('an answer that IS the prepared answer needs no model call after the reply', async () => {
    const { model, prompts } = textModel(KEY_REPLY);
    prepareAnswerKey('k1', input.question, cfg, { model });
    await takeAnswerKey('k1');
    const g = await gradeBlockOutput('quick_check', input, { answer: 'A buffer carried across reads.' }, cfg, { model, keyId: 'k1' });
    expect(g.verdict).toBe('correct');
    expect(prompts).toHaveLength(1); // the key, prepared earlier — nothing after the reply
    expect(g.source).toBe('model'); // a model wrote the key, so this can never mint applied-correctly
    expect(g.evidence[0].kind).toBe('explained-correctly');
  });

  it('otherwise compares the reply with the prepared key, and the grader sees both', async () => {
    const { model, prompts } = textModel((p) => (p.includes('Student answer') ? 'CORRECT — same idea, reworded' : KEY_REPLY));
    prepareAnswerKey('k2', input.question, cfg, { model });
    const g = await gradeBlockOutput('quick_check', input, { answer: 'keep the leftover bytes and prepend them next time' }, cfg, { model, keyId: 'k2' });
    expect(g.verdict).toBe('correct');
    const compare = prompts.find((p) => p.includes('Student answer'))!;
    expect(compare).toContain('a buffer carried across reads');
    expect(compare).toContain('they are joined with the next read');
    expect(compare).toContain('keep the leftover bytes');
  });

  // "How well", not just right or wrong: half an answer is neither a repair needed nor mastery.
  it('a partly right answer is PARTIAL — recorded as exposure, neither struggled nor explained', async () => {
    const { model } = textModel((p) => (p.includes('Student answer') ? 'PARTIAL — keeps the bytes, never says they are rejoined' : KEY_REPLY));
    prepareAnswerKey('k3', input.question, cfg, { model });
    const g = await gradeBlockOutput('quick_check', input, { answer: 'you keep the bytes' }, cfg, { model, keyId: 'k3' });
    expect(g.verdict).toBe('partial');
    expect(g.detail).toContain('never says they are rejoined');
    expect(g.evidence.map((e) => e.kind)).toEqual(['exposed']);
  });

  it.each(['PARTIALLY CORRECT: half of it', 'Partial\nmissing the rejoin', '**PARTIAL** — half'])('reads %j as partial', async (reply) => {
    const { model } = textModel((p) => (p.includes('Student answer') ? reply : KEY_REPLY));
    prepareAnswerKey('k4', input.question, cfg, { model });
    const g = await gradeBlockOutput('quick_check', input, { answer: 'x' }, cfg, { model, keyId: 'k4' });
    expect(g.verdict).toBe('partial');
  });

  it('with no prepared key it grades exactly as before', async () => {
    const { model, prompts } = textModel('CORRECT — fine');
    const g = await gradeBlockOutput('quick_check', input, { answer: 'a buffer' }, cfg, { model, keyId: 'nothing-prepared' });
    expect(g.verdict).toBe('correct');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toMatch(/prepared/i);
  });

  it('a blank reply is still never sent to a model', async () => {
    const { model, prompts } = textModel(KEY_REPLY);
    prepareAnswerKey('k5', input.question, cfg, { model });
    await takeAnswerKey('k5');
    const g = await gradeBlockOutput('quick_check', input, { answer: '   ' }, cfg, { model, keyId: 'k5' });
    expect(g.verdict).toBe('incorrect');
    expect(prompts).toHaveLength(1);
  });
});

import { prepareKeysForBlock } from '../src/server/answerKey.js';

describe('prepareKeysForBlock — a key only where a model would have to judge', () => {
  it('a free-text quick_check gets one, filed under the block\'s id, with the tutor\'s expected to check', async () => {
    const { model, prompts } = textModel(KEY_REPLY);
    prepareKeysForBlock('quick_check', 'tc-1', { question: 'Why buffer?', mode: 'text', expected: 'split lines', pageSlug: 'p' }, cfg, { model });
    expect((await takeAnswerKey('tc-1'))?.answer).toBe('a buffer carried across reads');
    expect(prompts[0]).toContain('split lines');
  });

  it('a multiple-choice quick_check does not — its answer is an exact match, no model involved', async () => {
    const { model, prompts } = textModel(KEY_REPLY);
    prepareKeysForBlock('quick_check', 'tc-2', { question: 'Pick one', mode: 'choice', choices: ['a', 'b'], expected: 'a', pageSlug: 'p' }, cfg, { model });
    expect(await takeAnswerKey('tc-2')).toBeNull();
    expect(prompts).toEqual([]);
  });

  it('a quiz gets one per SHORT item and none for choice or cloze items', async () => {
    const { model, prompts } = textModel(KEY_REPLY);
    prepareKeysForBlock('quiz', 'tc-3', { title: 't', items: [
      { id: 'q1', type: 'short', prompt: 'Explain buffering', pageSlug: 'p' },
      { id: 'q2', type: 'choice', prompt: 'Pick', choices: ['a', 'b'], expected: 'a', pageSlug: 'p' },
      { id: 'q3', type: 'short', prompt: 'Explain framing', pageSlug: 'p' },
    ] }, cfg, { model });
    expect(await takeAnswerKey('tc-3:q1')).not.toBeNull();
    expect(await takeAnswerKey('tc-3:q3')).not.toBeNull();
    expect(await takeAnswerKey('tc-3:q2')).toBeNull();
    expect(prompts).toHaveLength(2);
  });

  it('mechanically graded blocks and malformed input are left alone', async () => {
    const { model, prompts } = textModel(KEY_REPLY);
    prepareKeysForBlock('structured_check', 'tc-4', { prompt: 'x' }, cfg, { model });
    prepareKeysForBlock('quick_check', 'tc-5', null, cfg, { model });
    prepareKeysForBlock('record_evidence', 'tc-6', { slug: 'p' }, cfg, { model });
    expect(prompts).toEqual([]);
  });

  it('a quiz short item is then graded against ITS key', async () => {
    const { model, prompts } = textModel((p) => (p.includes('Student answer') ? 'CORRECT — yes' : KEY_REPLY));
    const quiz = { title: 't', items: [{ id: 'q1', type: 'short', prompt: 'Explain buffering', pageSlug: 'p' }] };
    prepareKeysForBlock('quiz', 'tc-7', quiz, cfg, { model });
    await gradeBlockOutput('quiz', quiz, { answers: [{ id: 'q1', answer: 'keep leftovers for the next read' }] }, cfg, { model, keyId: 'tc-7' });
    expect(prompts.find((p) => p.includes('Student answer'))).toContain('a buffer carried across reads');
  });
});
