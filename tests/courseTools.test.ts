// The tutor's course-bank tools (session.ts's buildCourseTools). What matters: course_problems
// hands over the VERBATIM text with stable ids, and mark_course_problem actually moves the bank's
// spacing state — and says so honestly when the id is wrong.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCourseTools } from '../src/server/session.js';
import { readBank, saveProblems } from '../src/server/courseBank.js';

function bankedVault() {
  const vault = mkdtempSync(join(tmpdir(), 'lwh-course-tools-'));
  saveProblems(vault, 'midterm-2', [
    { n: 1, text: 'State the pumping lemma for regular languages.', answer: 'see notes' },
    { n: 2, text: 'Define a spanning tree.' },
  ]);
  return vault;
}

const exec = (tools: any[], name: string, args: any) => tools.find((t) => t.name === name)!.execute!(args);

describe('course_problems', () => {
  it('returns the banked problems verbatim, with ids the model can hand back', async () => {
    const vault = bankedVault();
    const { problems } = await exec(buildCourseTools(vault), 'course_problems', {});
    expect(problems.map((p: any) => p.id)).toEqual(['midterm-2#1', 'midterm-2#2']);
    expect(problems[0].text).toBe('State the pumping lemma for regular languages.');
    expect(problems[0].answer).toBe('see notes');
  });

  it('says the bank is empty rather than inventing problems', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-course-tools-'));
    const out = await exec(buildCourseTools(vault), 'course_problems', {});
    expect(out.problems).toEqual([]);
    expect(out.note).toMatch(/empty/);
  });

  it('respects k', async () => {
    const vault = bankedVault();
    const { problems } = await exec(buildCourseTools(vault), 'course_problems', { k: 1 });
    expect(problems).toHaveLength(1);
  });
});

describe('mark_course_problem', () => {
  it('sets lastCorrect on the named problem — the never-answered count drops', async () => {
    const vault = bankedVault();
    const out = await exec(buildCourseTools(vault), 'mark_course_problem', { id: 'midterm-2#1' });
    expect(out).toEqual({ marked: 'midterm-2#1' });
    expect(readBank(vault).filter((p) => !p.lastCorrect).map((p) => p.id)).toEqual(['midterm-2#2']);
  });

  it('an unknown id is an error the model can read, not a silent no-op', async () => {
    const vault = bankedVault();
    const out = await exec(buildCourseTools(vault), 'mark_course_problem', { id: 'midterm-2#9' });
    expect(out.error).toMatch(/no banked problem/);
    expect(readBank(vault).every((p) => !p.lastCorrect)).toBe(true);
  });
});
