import { describe, it, expect } from 'vitest';
import { telex } from '../src/shared/telex.js';

// Telex replays raw ASCII keystrokes into Vietnamese. These pin the common cases a learner types;
// the placement rule is the modern style (see telex.ts). A few rare vowel clusters are approximate
// — the ImeInput toggle always lets the learner fall back to a system IME.
describe('telex — ASCII keystrokes to Vietnamese', () => {
  it('single-vowel tones', () => {
    expect(telex('nhaf')).toBe('nhà');   // huyền
    expect(telex('cas')).toBe('cá');     // sắc
    expect(telex('hoir')).toBe('hỏi');   // hỏi on the nucleus
    expect(telex('maxx')).toBe('max');   // re-pressed tone key undoes and emits literal
  });

  it('quality marks by doubling and by w', () => {
    expect(telex('aa')).toBe('â');
    expect(telex('oo')).toBe('ô');
    expect(telex('ee')).toBe('ê');
    expect(telex('aw')).toBe('ă');
    expect(telex('ow')).toBe('ơ');
    expect(telex('uw')).toBe('ư');
    expect(telex('w')).toBe('ư');       // bare w shorthand
    expect(telex('dd')).toBe('đ');
  });

  it('marked vowel takes the tone', () => {
    expect(telex('Vieejt')).toBe('Việt');   // ê carries nặng
    expect(telex('tieengs')).toBe('tiếng');  // ê carries sắc
    expect(telex('phowr')).toBe('phở');      // ơ carries hỏi
    expect(telex('nawngj')).toBe('nặng');    // ă carries nặng
  });

  it('the ươ cluster puts the tone on ơ, the second marked vowel', () => {
    expect(telex('dduwowcj')).toBe('được');    // đ + ư + ơ, nặng on ợ
    expect(telex('nguwowfi')).toBe('người');   // ư + ơ + i, huyền on ờ
  });

  it('leading tone-spelling consonants stay literal', () => {
    expect(telex('sao')).toBe('sao');   // s has no preceding vowel → literal
    expect(telex('xin')).toBe('xin');
    expect(telex('reo')).toBe('reo');
  });

  it('whole phrases across word boundaries', () => {
    expect(telex('Vieejt Nam')).toBe('Việt Nam');
    expect(telex('caf phee')).toBe('cà phê');
    expect(telex('tieengs Vieejt')).toBe('tiếng Việt');
  });

  it('closed vs open cluster placement', () => {
    expect(telex('hoaf')).toBe('hoà');   // open oa cluster → last vowel
    expect(telex('toans')).toBe('toán'); // closed → last vowel of cluster
  });

  it('passes plain ASCII with no Telex triggers through unchanged', () => {
    expect(telex('hello')).toBe('hello');
    expect(telex('123 go')).toBe('123 go');
  });
});
