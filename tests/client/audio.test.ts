// @vitest-environment jsdom
// Notation -> sound, mechanically: the same spelling the notes checker grades.
import { describe, it, expect } from 'vitest';
import { noteToFreq, parseNotes, playNotes } from '../../src/client/lib/audio.js';

describe('noteToFreq', () => {
  it('tunes A4 to 440 and spells accidentals both ways', () => {
    expect(noteToFreq('A4')).toBeCloseTo(440);
    expect(noteToFreq('a')).toBeCloseTo(440);          // default octave 4
    expect(noteToFreq('C#')!).toBeCloseTo(noteToFreq('Db')!); // enharmonic
    expect(noteToFreq('C5')!).toBeCloseTo(noteToFreq('C4')! * 2); // octave doubles
  });
  it('rejects non-notes rather than guessing', () => {
    expect(noteToFreq('H')).toBeNull();
    expect(noteToFreq('do')).toBeNull();
    expect(noteToFreq('')).toBeNull();
  });
});

describe('parseNotes', () => {
  it('splits on spaces and commas, skipping the unparseable', () => {
    expect(parseNotes('C, E G x')).toHaveLength(3);
  });
});

describe('playNotes', () => {
  it('is a silent no-op without an AudioContext (jsdom), never a crash', () => {
    expect(playNotes('C E G')).toBe(false);
  });
});
