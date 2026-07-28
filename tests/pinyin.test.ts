import { describe, it, expect } from 'vitest';
import { pinyin } from '../src/shared/pinyin.js';

// Pinyin tone placement is a well-defined rule (a/e win, ou→o, else last vowel); these pin the
// syllables a learner types most, plus the ü (typed "v") and neutral-tone cases.
describe('pinyin — ASCII + tone number to toned pinyin', () => {
  it('a and e always take the mark', () => {
    expect(pinyin('hao3')).toBe('hǎo');
    expect(pinyin('xie4')).toBe('xiè');
    expect(pinyin('ma1')).toBe('mā');
  });

  it('ou puts the mark on o; otherwise the last vowel', () => {
    expect(pinyin('dou1')).toBe('dōu');
    expect(pinyin('jiu3')).toBe('jiǔ');   // iu → last vowel u
    expect(pinyin('gui4')).toBe('guì');   // ui → last vowel u
    expect(pinyin('zhong1')).toBe('zhōng'); // single o
  });

  it('v is ü, and takes tones', () => {
    expect(pinyin('lv4')).toBe('lǜ');
    expect(pinyin('nv3')).toBe('nǚ');
  });

  it('neutral tone (5) and no number leave the syllable unmarked', () => {
    expect(pinyin('ma5')).toBe('ma');
    expect(pinyin('ma')).toBe('ma');
  });

  it('whole phrases across syllables and spaces', () => {
    expect(pinyin('ni3 hao3')).toBe('nǐ hǎo');
    expect(pinyin('ni3hao3')).toBe('nǐhǎo');       // no space still splits on the digit
    expect(pinyin('wo3 ai4 ni3')).toBe('wǒ ài nǐ');
  });

  it('preserves case and passes plain text through', () => {
    expect(pinyin('Bei3jing1')).toBe('Běijīng');
    expect(pinyin('hello world')).toBe('hello world');
  });
});
