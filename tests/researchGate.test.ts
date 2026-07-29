// When may the tutor research the web? Whenever its memory has a GAP for what the student just
// asked — and not otherwise.
//
// Two failure modes pull in opposite directions:
//
//   * Too tight and the tutor teaches from a placeholder. The first version of this gate only
//     unlocked when the vault had NO page, which missed the more common case: a page that exists but
//     is a stub, or cites nothing, or says almost nothing. "The vault has a page on it" can mean "the
//     vault has one sentence saying it should have one" — Engram auto-creates stubs for any
//     prereq nobody has written yet.
//   * Too loose and the tutor abandons a real page — with the student's own evidence, edges and
//     history on it — in favour of a stranger's blog post.
//
// The loose direction fails silently, so most of these tests are about it.

import { describe, it, expect } from 'vitest';
import { vaultGap, topicTokens } from '../src/server/session.js';
import type { UIMessage } from 'ai';

const user = (text: string): UIMessage =>
  ({ id: 'u', role: 'user', parts: [{ type: 'text', text }] }) as UIMessage;
const assistant = (text: string): UIMessage =>
  ({ id: 'a', role: 'assistant', parts: [{ type: 'text', text }] }) as UIMessage;

const SLUGS = ['derivatives', 'chain-rule'];

/** A page good enough to teach from: solid, sourced, and long enough to say something. */
const GOOD_PAGE = {
  meta: { status: 'solid', sources: ['https://example.edu/derivatives'] },
  body: 'x'.repeat(1200),
};

/** Stands in for Engram's `search`, which scores +3 for a title hit and +1 per body token. */
const vaultWith = (hits: Record<string, number>) =>
  async (query: string) => topicTokens(query)
    .flatMap((t) => Object.entries(hits).filter(([term]) => term === t))
    .map(([term, score]) => ({ slug: term, score }));

const noHits = async () => [];
const deps = (
  search: (q: string) => Promise<any[]>,
  page: any = GOOD_PAGE,
) => ({ search, readPage: async () => page });

describe('vaultGap — no gap, so stay grounded', () => {
  it('finds none when a solid sourced page covers the question', async () => {
    const gap = await vaultGap('learn', [user('remind me about derivatives')], SLUGS,
      deps(vaultWith({ derivatives: 3 })));
    expect(gap).toBeNull();
  });

  it('finds none when the student is just continuing, not naming a subject', async () => {
    for (const said of ['ok', 'sure, next', 'yes please', 'go on']) {
      expect(await vaultGap('learn', [user(said)], SLUGS, deps(noHits))).toBeNull();
    }
  });

  it('fails closed if the vault cannot be searched', async () => {
    // Not knowing whether the vault covers the topic is not a licence to leave it.
    const broken = async () => { throw new Error('index unreadable'); };
    expect(await vaultGap('learn', [user('explain counterpoint')], SLUGS, deps(broken))).toBeNull();
  });

  it('fails closed if the on-topic page cannot be read', async () => {
    const gap = await vaultGap('learn', [user('derivatives again')], SLUGS, {
      search: vaultWith({ derivatives: 3 }),
      readPage: async () => { throw new Error('ENOENT'); },
    });
    expect(gap).toBeNull();
  });
});

describe('vaultGap — the gap kinds, each for a different reason', () => {
  it('empty-vault: nothing can ground anything', async () => {
    const gap = await vaultGap('learn', [user('teach me counterpoint')], [], deps(noHits));
    expect(gap?.reason).toBe('empty-vault');
  });

  it('no-page: pages exist, none on this topic', async () => {
    const gap = await vaultGap('learn', [user('explain species counterpoint')], SLUGS, deps(noHits));
    expect(gap?.reason).toBe('no-page');
    expect(gap?.slug).toBeUndefined();
  });

  it('stub: the page is Engram\'s own placeholder for a prereq nobody wrote', async () => {
    const gap = await vaultGap('learn', [user('what about derivatives')], SLUGS, deps(
      vaultWith({ derivatives: 3 }),
      { meta: { status: 'stub', sources: [] }, body: '_Stub created by link validation._' },
    ));
    expect(gap?.reason).toBe('stub');
    expect(gap?.slug).toBe('derivatives');
    expect(gap?.detail).toContain('derivatives');
  });

  it('unsourced: the page is the vault\'s own record that it was never checked', async () => {
    // This is the case the goal cares most about. A long, confident, entirely unverified page reads
    // exactly like a good one to everyone except the sources list.
    const gap = await vaultGap('learn', [user('what about derivatives')], SLUGS, deps(
      vaultWith({ derivatives: 3 }),
      { meta: { status: 'solid', sources: [] }, body: 'x'.repeat(5000) },
    ));
    expect(gap?.reason).toBe('unsourced');
    expect(gap?.detail).toMatch(/cites no sources/);
  });

  it('thin: sourced and solid, but there is nothing on the page', async () => {
    const gap = await vaultGap('learn', [user('what about derivatives')], SLUGS, deps(
      vaultWith({ derivatives: 3 }),
      { meta: { status: 'solid', sources: ['https://example.edu/x'] }, body: 'The slope. See also.' },
    ));
    expect(gap?.reason).toBe('thin');
    expect(gap?.detail).toMatch(/too thin/);
  });

  it('checks the gap kinds in order of severity, so a stub is a stub and not "unsourced"', async () => {
    // A stub is also unsourced and also thin. Reporting the most specific reason is what makes the
    // tutor's explanation to the student true rather than merely technically correct.
    const gap = await vaultGap('learn', [user('what about derivatives')], SLUGS, deps(
      vaultWith({ derivatives: 3 }),
      { meta: { status: 'stub', sources: [] }, body: '' },
    ));
    expect(gap?.reason).toBe('stub');
  });
});

describe('vaultGap — matching the question to the page', () => {
  it('is not fooled by a body-only coincidence', async () => {
    // A page mentioning "rate" in passing is not a page about tax rates.
    const gap = await vaultGap('learn', [user('how do marginal tax rates work')], SLUGS,
      deps(vaultWith({ rates: 1 })));
    expect(gap?.reason).toBe('no-page');
  });

  it('ignores stopwords, so a shared "what/is/the" cannot look like coverage', async () => {
    // The concrete bug the stopword list exists for: Engram's search scores +1 per body token,
    // so a page about anything at all matches three of the words in almost any question.
    const gap = await vaultGap('learn', [user('what is the tonic of a minor key')], SLUGS,
      deps(vaultWith({ what: 1, is: 1, the: 1 })));
    expect(gap?.reason).toBe('no-page');
    expect(topicTokens('what is the tonic of a minor key')).toEqual(['tonic', 'minor', 'key']);
  });

  it('reads the LAST student message, not the first', async () => {
    const history = [
      user('teach me derivatives'),
      assistant('here is the power rule'),
      user('what about stochastic calculus'),
    ];
    const gap = await vaultGap('learn', history, SLUGS, deps(vaultWith({ derivatives: 3 })));
    expect(gap?.reason).toBe('no-page');
  });
});

describe('vaultGap — modes', () => {
  it('freeform always researches, and says so as its own reason', async () => {
    const gap = await vaultGap('freeform', [user('anything')], SLUGS, deps(noHits));
    expect(gap?.reason).toBe('freeform');
  });

  it('applies to review and quiz too, not just learn', async () => {
    for (const mode of ['review', 'quiz'] as const) {
      expect((await vaultGap(mode, [user('explain counterpoint')], SLUGS, deps(noHits)))?.reason)
        .toBe('no-page');
      expect(await vaultGap(mode, [user('derivatives again')], SLUGS, deps(vaultWith({ derivatives: 3 }))))
        .toBeNull();
    }
  });
});
