// The course bank: past exams and problem sets extracted VERBATIM into a drillable bank.
// The alignment contract under test: what the professor wrote is what the learner is asked.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractProblems, readBank, saveProblems, markCorrect, nextProblems } from '../src/server/courseBank.js';

const EXAM = `# Midterm 2, CHEM 201

## Section A

1. Calculate the molarity of 4 g NaOH in 500 mL of water.
   Show your working.

Answer: 0.2 mol/L

2) Balance: Fe + O2 -> Fe2O3

(3) Explain why the reaction in problem 2 is exothermic,
citing bond enthalpies.

Problem 4: A buffer contains equal molar acetic acid and acetate.
What is its pH? (pKa = 4.76)

Solution: pH = pKa = 4.76

---

Good luck!
`;

describe('extractProblems', () => {
  it('extracts every numbered form with verbatim text', () => {
    const got = extractProblems(EXAM);
    expect(got.map((p) => p.n)).toEqual([1, 2, 3, 4]);
    expect(got[0].text).toContain('molarity of 4 g NaOH');
    expect(got[0].text).toContain('Show your working.');
    expect(got[1].text).toBe('Balance: Fe + O2 -> Fe2O3');
    expect(got[2].text).toContain('citing bond enthalpies');
  });

  it('captures inline Answer/Solution blocks separately from the statement', () => {
    const got = extractProblems(EXAM);
    expect(got[0].answer).toBe('0.2 mol/L');
    expect(got[3].answer).toBe('pH = pKa = 4.76');
    expect(got[1].answer).toBeUndefined();
    // The answer never bleeds into the statement the learner will be shown.
    expect(got[0].text).not.toContain('0.2 mol/L');
  });

  it('refuses to treat ordinary prose with a short list as a problem set', () => {
    // A textbook chapter with a two-item list must NOT become a bogus bank.
    const prose = '# Chapter 3\n\nSome text.\n\n1. a minor aside\n2. another aside\n\nMore prose.';
    expect(extractProblems(prose)).toEqual([]);
  });

  it('a heading ends a problem without starting a new one', () => {
    const got = extractProblems(EXAM);
    // "## Section A" precedes problem 1; "Good luck!" after the hr is nobody's problem text.
    expect(got.every((p) => !p.text.includes('Good luck'))).toBe(true);
  });
});

describe('bank storage', () => {
  let vault: string;
  beforeEach(() => { vault = mkdtempSync(join(tmpdir(), 'lwh-bank-')); });
  afterEach(() => { rmSync(vault, { recursive: true, force: true }); });

  it('saves, reads back, and namespaces ids by source', () => {
    const saved = saveProblems(vault, 'chem201-midterm2', extractProblems(EXAM));
    expect(saved).toHaveLength(4);
    expect(saved[0].id).toBe('chem201-midterm2#1');
    expect(readBank(vault)).toHaveLength(4);
  });

  it('re-ingesting a source replaces its entries instead of duplicating', () => {
    saveProblems(vault, 'chem201-midterm2', extractProblems(EXAM));
    saveProblems(vault, 'chem201-midterm2', extractProblems(EXAM));
    expect(readBank(vault)).toHaveLength(4);
  });

  it('nextProblems serves never-answered first, then correct-longest-ago', () => {
    saveProblems(vault, 'chem201-midterm2', extractProblems(EXAM));
    expect(markCorrect(vault, 'chem201-midterm2#1', 'kid')).toBe(true);
    const next = nextProblems(vault, 'kid', 4);
    // 2,3,4 are unanswered and come first; 1 (answered today) is last.
    expect(next.map((p) => p.n)).toEqual([2, 3, 4, 1]);
  });

  // Real psets repeat printed numbers across sections (two "Problem 1"s), and parseFloat
  // collapses "2.10" into 2.1 — colliding ids let markCorrect mark the wrong problem and made
  // the second holder unreachable. Repeats now carry a stable occurrence suffix.
  it('repeated printed numbers get distinct, stable ids', () => {
    const problems = [
      { n: 1, text: 'Section A problem one' },
      { n: 2, text: 'Section A problem two' },
      { n: 1, text: 'Section B problem one' },
      { n: 1, text: 'Section C problem one' },
    ];
    const saved = saveProblems(vault, 'two-part-exam', problems);
    expect(saved.map((p) => p.id)).toEqual([
      'two-part-exam#1', 'two-part-exam#2', 'two-part-exam#1~2', 'two-part-exam#1~3',
    ]);
    // The suffixed id is individually markable — the collision made this impossible before.
    expect(markCorrect(vault, 'two-part-exam#1~2', 'kid')).toBe(true);
    const bank = readBank(vault);
    expect(bank.find((e) => e.text === 'Section B problem one')!.lastCorrect).toBeTruthy();
    expect(bank.find((e) => e.text === 'Section A problem one')!.lastCorrect).toBeUndefined();
    // Re-ingesting reproduces the same ids (deterministic extraction order).
    expect(saveProblems(vault, 'two-part-exam', problems).map((p) => p.id))
      .toEqual(['two-part-exam#1', 'two-part-exam#2', 'two-part-exam#1~2', 'two-part-exam#1~3']);
  });

  it('markCorrect on an unknown id reports failure rather than inventing an entry', () => {
    saveProblems(vault, 'chem201-midterm2', extractProblems(EXAM));
    expect(markCorrect(vault, 'nope#9', 'kid')).toBe(false);
    expect(readBank(vault)).toHaveLength(4);
  });
});

describe('courseSeeds', () => {
  const { mkdtempSync: mkd, rmSync: rms } = require('node:fs') as typeof import('node:fs');
  const { tmpdir: tmp } = require('node:os') as typeof import('node:os');
  const { join: j } = require('node:path') as typeof import('node:path');
  it('derives one stub page per banked source, so drill evidence has a home', async () => {
    const { courseSeeds } = await import('../src/server/seedPatternPages.js');
    const v = mkd(j(tmp(), 'lwh-seed-'));
    try {
      saveProblems(v, 'chem201-midterm2', extractProblems(EXAM));
      const seeds = courseSeeds(v);
      expect(seeds).toHaveLength(1);
      expect(seeds[0].slug).toBe('course-chem201-midterm2');
      expect(seeds[0].domain).toBe('course');
    } finally { rms(v, { recursive: true, force: true }); }
  });
  it('an empty bank seeds nothing', async () => {
    const { courseSeeds } = await import('../src/server/seedPatternPages.js');
    const v = mkd(j(tmp(), 'lwh-seed-'));
    try { expect(courseSeeds(v)).toEqual([]); } finally { rms(v, { recursive: true, force: true }); }
  });
});

/**
 * The bank is vault-level material, but "have you answered this" is a fact about a PERSON. With one
 * shared flag the first learner to answer a past-exam question hid it from everyone else on the
 * vault — while their evidence stayed properly separate, which is what made it easy to miss.
 */
describe('the bank tracks answers per student', () => {
  it('one student answering does not hide the problem from another', () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-bank-multi-'));
    saveProblems(vault, 'exam1', [{ n: 1, text: 'First problem.' }, { n: 2, text: 'Second problem.' }]);
    const first = nextProblems(vault, 'ana')[0];

    expect(markCorrect(vault, first.id, 'ana')).toBe(true);
    // ana has answered it, so it drops behind her never-answered ones.
    expect(nextProblems(vault, 'ana')[0].id).not.toBe(first.id);
    // ben has answered nothing: it is still his first.
    expect(nextProblems(vault, 'ben')[0].id).toBe(first.id);
  });

  it('honours a legacy bank written before per-student answers existed', () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-bank-legacy-'));
    saveProblems(vault, 'exam1', [{ n: 1, text: 'First problem.' }, { n: 2, text: 'Second problem.' }]);
    const all = readBank(vault);
    // The old shape: a bare lastCorrect with no lastCorrectBy.
    writeFileSync(join(vault, '.harness', 'course-bank.jsonl'),
      all.map((e, i) => JSON.stringify(i === 0 ? { ...e, lastCorrect: '2026-01-01' } : e)).join('\n') + '\n');
    // Reads as answered, so a single-student vault behaves exactly as it did before.
    expect(nextProblems(vault, 'ana')[0].id).not.toBe(all[0].id);
  });
});
