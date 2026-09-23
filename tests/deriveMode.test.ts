import { describe, it, expect } from 'vitest';
import { deriveMode } from '../src/server/deriveMode.js';

const m = (text: string, planKinds: string[] = [], emptyVault = false) =>
  deriveMode({ text, planKinds, emptyVault });

describe('deriveMode — an explicit ask wins', () => {
  // Chat can research, write, ingest and build paths, so an authoring ask needs no mode of its own
  // any more. It still outranks the plan: asked to build something, the learner is not reviewing.
  it('routes syllabus-building to chat, over the plan', () => {
    expect(m('build me a path for music theory', ['review'])).toBe('chat');
    expect(m('can you create a syllabus for linear algebra?', ['review'])).toBe('chat');
    expect(m('set up a roadmap for me', ['review'])).toBe('chat');
  });

  it('routes adding material to chat, over the plan', () => {
    expect(m('add this repo to my library', ['quiz'])).toBe('chat');
    expect(m('compile this paper please', ['quiz'])).toBe('chat');
    expect(m('save this as a page', ['quiz'])).toBe('chat');
  });

  it('routes being tested to quiz', () => {
    expect(m('quiz me')).toBe('quiz');
    expect(m('test me on what I know')).toBe('quiz');
  });

  it('routes going back over old ground to review', () => {
    expect(m('can we review yesterday?')).toBe('review');
    expect(m('review')).toBe('review');
    expect(m("let's review what I did last week")).toBe('review');
    expect(m('review my weak pages')).toBe('review');
    expect(m('what have I forgotten?')).toBe('review');
    expect(m('what has slipped?')).toBe('review');
  });

  it('beats the plan — the learner outranks the suggestions', () => {
    expect(m('quiz me', ['review'])).toBe('quiz');
    expect(m('build me a path', ['review'])).toBe('chat');
  });
});

describe('deriveMode — the plan decides when nothing is asked', () => {
  it('follows the leading plan item', () => {
    expect(m('ok next', ['review', 'new'])).toBe('review');
    expect(m('keep going', ['quiz', 'new'])).toBe('quiz');
    expect(m('ok', ['misconception'])).toBe('review');
    expect(m('ok', ['new', 'review'])).toBe('chat');
  });

  // Chat is the default because nearly every harness bug on 2026-09-22 came from the tutor's
  // per-turn forcing (a greeting answered with last session's topic, research locked on "sure",
  // blocks forced into turns that wanted an answer). The structured tutor is one command away.
  it('defaults to chat with no plan and no ask', () => {
    expect(m('teach me about tensors')).toBe('chat');
    expect(m('hi')).toBe('chat');
    expect(m('')).toBe('chat');
  });
});

describe('deriveMode — an empty vault', () => {
  it('is chat, which researches and writes — even over the plan', () => {
    // What coldStartMode existed to express: teaching modes could not write, so a newcomer's first
    // lesson "researched well, taught well, and then evaporated". Chat can write.
    expect(m('teach me about jazz harmony', [], true)).toBe('chat');
    expect(m('ok', ['review'], true)).toBe('chat');
  });

  it('still lets an explicit ask through', () => {
    expect(m('quiz me', [], true)).toBe('quiz');
  });
});

describe('deriveMode — ordinary teaching is not mistaken for something else', () => {
  it('does not read a topic mentioning these words as a mode switch', () => {
    // "review" inside a SUBJECT is not a request to review — the word only means the mode when
    // it is addressed at the session or at the learner's own material.
    expect(m('teach me how code review works at Google')).toBe('chat');
    expect(m('explain peer review in academic publishing')).toBe('chat');
    expect(m('explain the PyTorch autograd engine')).toBe('chat');
    expect(m('what is a learning rate schedule?')).toBe('chat');
    expect(m('how do generators differ from iterators?')).toBe('chat');
    // A bare "forget" is not a review request — it appears constantly in ordinary teaching.
    expect(m("don't forget the chain rule — explain it to me")).toBe('chat');
  });
});

/**
 * The failure mode that matters once the selector is gone: an ordinary teaching request that
 * happens to CONTAIN a mode word being hijacked into the wrong mode. A learner asking about A/B
 * testing must not be quizzed, and one asking how to build a compiler must not have a syllabus
 * authored at them.
 */
describe('deriveMode — mode words inside a subject', () => {
  const subjects = [
    'explain how unit tests work in pytest',
    'teach me about A/B testing',
    'what is test-driven development?',
    'explain code review culture',
    'how do I build a compiler?',
    'teach me how to build a neural network from scratch',
    'explain the quiz show scandal of 1958',
    'what does the reviewer do in peer review?',
    'teach me about course design',
    'how does a learning path in Duolingo work?',
    'explain how to add two matrices',
    'what is a curriculum learning strategy in ML?',
  ];
  // Two checks, because chat is now both the default and where an authoring ask goes: with no plan,
  // a misfiring quiz or review pattern shows as quiz/review; under a misconception-led plan, the
  // plan decides (review) unless an authoring (chat) or quiz pattern misfired.
  it.each(subjects)('%s → no ask', (text) => {
    expect(deriveMode({ text })).toBe('chat');
    expect(deriveMode({ text, planKinds: ['misconception'] })).toBe('review');
  });

  const asks: [string, string][] = [
    ['quiz me', 'quiz'],
    ['test me on chapter 3', 'quiz'],
    ['can we review what I did last week', 'review'],
    ['review my weak pages', 'review'],
    ['build me a syllabus for music theory', 'chat'],
    ['create a learning path for rust', 'chat'],
    ['add this paper to my library', 'chat'],
    ['import this repo', 'chat'],
  ];
  it.each(asks)('%s → %s', (text, want) => {
    expect(deriveMode({ text, planKinds: ['misconception'] })).toBe(want);
  });
});

/**
 * "Keep this" has many more phrasings than the first cut allowed. A live sitting asked "save what
 * we covered as a page I can come back to" and got a one-click offer button instead of a page,
 * because the derivation never unlocked writing — the learner had to ask twice for something they
 * had already asked for plainly.
 */
describe('deriveMode — asking to keep the work', () => {
  const keeps = [
    'save what we covered as a page I can come back to',
    'save this',
    'save that as a note',
    'keep this for later',
    'store what we did in my vault',
    'write this up',
    'write that down',
    'make me a page on this',
    'turn this into a page',
  ];
  it.each(keeps)('%s → chat, over the plan', (text) => {
    expect(deriveMode({ text, planKinds: ['misconception'] })).toBe('chat');
  });

  it('does not fire on ordinary teaching that mentions saving', () => {
    expect(deriveMode({ text: 'explain how autosave works in vim', planKinds: ['misconception'] })).toBe('review');
    expect(deriveMode({ text: 'teach me how databases keep data durable', planKinds: ['misconception'] })).toBe('review');
  });
});
