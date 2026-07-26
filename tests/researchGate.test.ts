// The cold-start unlock: teaching modes may research the web ONLY when the vault has no page for
// what the student just asked about.
//
// Two failure modes are worth guarding against, and they pull in opposite directions:
//
//   * Too tight (the old freeform-only gate) and a student who names an uncovered subject in `learn`
//     mode gets a tutor with no search, no write_page and no ingest — it can only refuse.
//   * Too loose and the tutor searches the web for a topic the vault already holds a page on,
//     abandoning the student's own evidence, edges and history in favour of a stranger's blog post.
//
// The loose direction is the one that fails silently, so most of these tests are about it.

import { describe, it, expect } from 'vitest';
import { researchUnlocked, topicTokens } from '../src/server/session.js';
import type { UIMessage } from 'ai';

const user = (text: string): UIMessage =>
  ({ id: 'u', role: 'user', parts: [{ type: 'text', text }] }) as UIMessage;
const assistant = (text: string): UIMessage =>
  ({ id: 'a', role: 'assistant', parts: [{ type: 'text', text }] }) as UIMessage;

const SLUGS = ['derivatives', 'chain-rule'];

/** Stands in for Loreweaver's `search`, which scores +3 for a title hit and +1 per body token. */
const vaultWith = (hits: Record<string, number>) =>
  async (query: string) => topicTokens(query)
    .flatMap((t) => Object.entries(hits).filter(([term]) => term === t))
    .map(([term, score]) => ({ slug: term, score }));

const noHits = async () => [];

describe('researchUnlocked', () => {
  it('is always on in freeform — that is where subjects get researched and compiled', async () => {
    expect(await researchUnlocked('freeform', [user('anything')], SLUGS, noHits)).toBe(true);
  });

  it('is on in a teaching mode when the vault is empty, because nothing can ground anything', async () => {
    expect(await researchUnlocked('learn', [user('teach me counterpoint')], [], noHits)).toBe(true);
  });

  it('is on when the vault has pages but none of them cover the question', async () => {
    expect(await researchUnlocked('learn', [user('explain species counterpoint')], SLUGS, noHits))
      .toBe(true);
  });

  it('is OFF when a page title matches — the vault page wins over a search result', async () => {
    const search = vaultWith({ derivatives: 3 });
    expect(await researchUnlocked('learn', [user('remind me about derivatives')], SLUGS, search))
      .toBe(false);
  });

  it('is NOT fooled by a body-only coincidence', async () => {
    // A page mentioning "rate" in passing is not a page about tax rates.
    const search = vaultWith({ rates: 1 });
    expect(await researchUnlocked('learn', [user('how do marginal tax rates work')], SLUGS, search))
      .toBe(true);
  });

  it('ignores stopwords, so a shared "what/is/the" cannot look like coverage', async () => {
    // This is the concrete bug the stopword list exists for: score +1 per body token means a page
    // about anything at all matches three of the words in almost any question.
    const search = vaultWith({ what: 1, is: 1, the: 1 });
    expect(await researchUnlocked('learn', [user('what is the tonic of a minor key')], SLUGS, search))
      .toBe(true);
    expect(topicTokens('what is the tonic of a minor key')).toEqual(['tonic', 'minor', 'key']);
  });

  it('stays off when the student is just continuing, not naming a subject', async () => {
    for (const said of ['ok', 'sure, next', 'yes please', 'go on']) {
      expect(await researchUnlocked('learn', [user(said)], SLUGS, noHits)).toBe(false);
    }
  });

  it('reads the LAST student message, not the first', async () => {
    const history = [
      user('teach me derivatives'),
      assistant('here is the power rule'),
      user('what about stochastic calculus'),
    ];
    expect(await researchUnlocked('learn', history, SLUGS, vaultWith({ derivatives: 3 }))).toBe(true);
  });

  it('fails closed if the vault cannot be searched', async () => {
    // Not knowing whether the vault covers the topic is not a licence to leave it.
    const broken = async () => { throw new Error('index unreadable'); };
    expect(await researchUnlocked('learn', [user('explain counterpoint')], SLUGS, broken)).toBe(false);
  });

  it('applies to review and quiz too, not just learn', async () => {
    for (const mode of ['review', 'quiz'] as const) {
      expect(await researchUnlocked(mode, [user('explain counterpoint')], SLUGS, noHits)).toBe(true);
      expect(await researchUnlocked(mode, [user('derivatives again')], SLUGS, vaultWith({ derivatives: 3 })))
        .toBe(false);
    }
  });
});
