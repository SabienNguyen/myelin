// The course bank: past exams and problem sets extracted VERBATIM into a drillable bank.
// The alignment contract under test: what the professor wrote is what the learner is asked.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
    expect(markCorrect(vault, 'chem201-midterm2#1')).toBe(true);
    const next = nextProblems(vault, 4);
    // 2,3,4 are unanswered and come first; 1 (answered today) is last.
    expect(next.map((p) => p.n)).toEqual([2, 3, 4, 1]);
  });

  it('markCorrect on an unknown id reports failure rather than inventing an entry', () => {
    saveProblems(vault, 'chem201-midterm2', extractProblems(EXAM));
    expect(markCorrect(vault, 'nope#9')).toBe(false);
    expect(readBank(vault)).toHaveLength(4);
  });
});
