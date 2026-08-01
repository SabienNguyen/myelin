import { describe, it, expect } from 'vitest';
import { deriveMode } from '../src/server/deriveMode.js';

const m = (text: string, planKinds: string[] = [], emptyVault = false) =>
  deriveMode({ text, planKinds, emptyVault });

describe('deriveMode — an explicit ask wins', () => {
  it('routes syllabus-building to freeform', () => {
    expect(m('build me a path for music theory')).toBe('freeform');
    expect(m('can you create a syllabus for linear algebra?')).toBe('freeform');
    expect(m('set up a roadmap for me')).toBe('freeform');
  });

  it('routes adding material to freeform', () => {
    expect(m('add this repo to my library')).toBe('freeform');
    expect(m('compile this paper please')).toBe('freeform');
    expect(m('save this as a page')).toBe('freeform');
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
    expect(m('build me a path', ['review'])).toBe('freeform');
  });
});

describe('deriveMode — the plan decides when nothing is asked', () => {
  it('follows the leading plan item', () => {
    expect(m('ok next', ['review', 'new'])).toBe('review');
    expect(m('keep going', ['quiz', 'new'])).toBe('quiz');
    expect(m('ok', ['misconception'])).toBe('review');
    expect(m('ok', ['new', 'review'])).toBe('learn');
  });

  it('defaults to learn with no plan and no ask', () => {
    expect(m('teach me about tensors')).toBe('learn');
    expect(m('')).toBe('learn');
  });
});

describe('deriveMode — an empty vault', () => {
  it('is freeform, because research-and-write is all a turn can be', () => {
    // What coldStartMode existed to express: teaching modes could not write, so a newcomer's first
    // lesson "researched well, taught well, and then evaporated".
    expect(m('teach me about jazz harmony', [], true)).toBe('freeform');
  });

  it('still lets an explicit ask through', () => {
    expect(m('quiz me', [], true)).toBe('quiz');
  });
});

describe('deriveMode — ordinary teaching is not mistaken for something else', () => {
  it('does not read a topic mentioning these words as a mode switch', () => {
    // "review" inside a SUBJECT is not a request to review — the word only means the mode when
    // it is addressed at the session or at the learner's own material.
    expect(m('teach me how code review works at Google')).toBe('learn');
    expect(m('explain peer review in academic publishing')).toBe('learn');
    expect(m('explain the PyTorch autograd engine')).toBe('learn');
    expect(m('what is a learning rate schedule?')).toBe('learn');
    expect(m('how do generators differ from iterators?')).toBe('learn');
    // A bare "forget" is not a review request — it appears constantly in ordinary teaching.
    expect(m("don't forget the chain rule — explain it to me")).toBe('learn');
  });
});

/**
 * The failure mode that matters once the selector is gone: an ordinary teaching request that
 * happens to CONTAIN a mode word being hijacked into the wrong mode. A learner asking about A/B
 * testing must not be quizzed, and one asking how to build a compiler must not have a syllabus
 * authored at them.
 */
describe('deriveMode — mode words inside a subject', () => {
  const learn = [
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
  it.each(learn)('%s → learn', (text) => {
    expect(deriveMode({ text })).toBe('learn');
  });

  const asks: [string, string][] = [
    ['quiz me', 'quiz'],
    ['test me on chapter 3', 'quiz'],
    ['can we review what I did last week', 'review'],
    ['review my weak pages', 'review'],
    ['build me a syllabus for music theory', 'freeform'],
    ['create a learning path for rust', 'freeform'],
    ['add this paper to my library', 'freeform'],
    ['import this repo', 'freeform'],
  ];
  it.each(asks)('%s → %s', (text, want) => {
    expect(deriveMode({ text })).toBe(want);
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
  it.each(keeps)('%s → freeform', (text) => {
    expect(deriveMode({ text })).toBe('freeform');
  });

  it('does not fire on ordinary teaching that mentions saving', () => {
    expect(deriveMode({ text: 'explain how autosave works in vim' })).toBe('learn');
    expect(deriveMode({ text: 'teach me how databases keep data durable' })).toBe('learn');
  });
});
