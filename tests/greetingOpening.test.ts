import { describe, it, expect } from 'vitest';
import { isBareGreeting, vaultGap, topicTokens } from '../src/server/session.js';
import { buildBootstrapContext } from '../src/server/prompt.js';
import type { UIMessage } from '../src/shared/uiMessages.js';

// Reported from a live sitting: open a new session, say "hi", and the tutor resumes the previous
// session's topic as though it had been asked for. Three separate mechanisms read a greeting as a
// request — the LEARN framing, the produce-a-block note, and vaultGap — and this file pins each.

const userSays = (text: string): UIMessage[] => [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text }] },
];

describe('isBareGreeting', () => {
  it.each([
    'hi', 'Hi!', 'hey', 'hey there', 'hello', 'Hello.', 'yo', 'sup', 'howdy',
    'good morning', 'Good evening', 'morning', "what's up", 'how are you',
    "how's it going", "i'm back", 'hi again',
  ])('treats %j as an opening with no ask', (text) => {
    expect(isBareGreeting(text)).toBe(true);
  });

  // The strictness that matters: every word must be a greeting word, so a greeting that carries a
  // request is a request. Getting this wrong would silently swallow real asks.
  it.each([
    'hi, teach me calculus',
    'hey can we do derivatives',
    'hello world program in rust',
    'good morning — what is a monad',
    'teach me something',
    'quiz me',
    'ok',
    'next',
    '',
  ])('does not treat %j as a bare greeting', (text) => {
    expect(isBareGreeting(text)).toBe(false);
  });

  it('is not fooled by a long message that merely opens with a greeting', () => {
    expect(isBareGreeting('hey so i was thinking about how the chain rule actually works')).toBe(false);
  });
});

describe('a greeting does not unlock research', () => {
  // topicTokens("hello") is ["hello"] — which is why this needed a shape check and not a stopword.
  it('still reads greeting words as topic tokens — the gap check must not rely on that', () => {
    expect(topicTokens('hello')).toEqual(['hello']);
    expect(topicTokens('hey')).toEqual(['hey']);
  });

  it('returns no gap for a greeting, so web_search and write_page stay locked', async () => {
    let searched = false;
    const gap = await vaultGap('learn', userSays('hello'), ['derivatives'], {
      search: async () => { searched = true; return []; },
      readPage: async () => ({ meta: {}, body: '' }),
    });
    // Before the fix: no page scores on "hello" → reason 'no-page' → research and write_page
    // unlocked, and the tutor told to write the page it just researched.
    expect(gap).toBeNull();
    expect(searched).toBe(false);
  });

  it('still opens the gap for a greeting that carries a real ask', async () => {
    const queries: string[] = [];
    const gap = await vaultGap('learn', userSays('hi, teach me about monads'), ['derivatives'], {
      search: async (q) => { queries.push(q); return []; },
      readPage: async () => ({ meta: {}, body: '' }),
    });
    expect(gap?.reason).toBe('no-page');
    expect(queries[0]).toContain('monads');
  });
});

describe('the opening framing', () => {
  const base = { state: {}, lessons: [], reviewsDue: [], ankiLapses: [] };

  it('tells the tutor to offer and wait when the session opened on a greeting', () => {
    const ctx = buildBootstrapContext({ ...base, mode: 'learn', greeting: true });
    expect(ctx).toContain('opened with a greeting');
    expect(ctx).toContain('Do not stage a block');
    expect(ctx).toContain('name ONE');
    // The instruction it replaces — the one that resumed last session's topic.
    expect(ctx).not.toContain('Teach the next suggested lesson');
  });

  it('keeps the ordinary framing when the student said something', () => {
    const ctx = buildBootstrapContext({ ...base, mode: 'learn' });
    expect(ctx).toContain('Teach the next suggested lesson');
    expect(ctx).not.toContain('opened with a greeting');
  });

  // The suggestions are still injected: the tutor needs them to make the offer. What changed is
  // that it offers instead of launching.
  it('still carries what is waiting, so the offer can be specific', () => {
    const ctx = buildBootstrapContext({
      ...base, mode: 'learn', greeting: true,
      lessons: [{ slug: 'derivatives', title: 'Derivatives', reason: 'review-due', detail: 'due today' }],
      reviewsDue: ['derivatives'],
    });
    expect(ctx).toContain('derivatives');
    expect(ctx).toContain('Reviews due: derivatives');
  });
});
