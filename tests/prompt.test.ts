import { describe, it, expect } from 'vitest';
import { buildBootstrapContext, buildInstructions } from '../src/server/prompt.js';

describe('prompt assembly', () => {
  it('instructions include the evidence rule', () => {
    expect(buildInstructions()).toMatch(/record_evidence/);
  });

  // A live first sitting opened with an unframed quiz on never-taught material and a path the
  // learner couldn't see — both experienced as "this assumes I already know it" and "no coherent
  // journey". The two phrases below are the load-bearing fixes: first-contact probes announce
  // themselves as calibration, and a new path is narrated as stops in the chat.
  it('instructions frame first-contact probes and require narrating the path', () => {
    const instructions = buildInstructions();
    expect(instructions).toMatch(/calibration, not a test/);
    expect(instructions).toMatch(/show the journey in the\s+chat/);
  });

  // Goal + cold start. Both exist because the system could previously answer "what next across the
  // whole vault" but not "how far through THIS subject am I", and because learn/review/quiz expose no
  // page-writing tools — so an empty vault left the tutor silently unable to act.
  const base = { mode: 'learn' as const, state: {}, lessons: [], reviewsDue: [], ankiLapses: [] };

  it('reports an active path goal with its progress and resume point', () => {
    const ctx = buildBootstrapContext({
      ...base,
      goal: { kind: 'path', slug: 'music-theory', title: 'Music Theory', known: 2, total: 5, nextSlug: 'intervals' },
    });
    expect(ctx).toMatch(/Active goal: path "Music Theory" \(music-theory\)/);
    expect(ctx).toMatch(/2\/5 pages known/);
    expect(ctx).toMatch(/resume at intervals/);
  });
  it('says a complete goal is complete rather than printing a resume point', () => {
    const ctx = buildBootstrapContext({
      ...base, goal: { kind: 'path', slug: 'p', known: 3, total: 3, nextSlug: null },
    });
    expect(ctx).toMatch(/3\/3 pages known, complete/);
    expect(ctx).not.toMatch(/resume at/);
  });
  it('invites setting a goal when none is active', () => {
    const ctx = buildBootstrapContext({ ...base, goal: null });
    expect(ctx).toMatch(/Active goal: none/);
    expect(ctx).toMatch(/create_path/);
  });
  it('names the course bank when problems are waiting, and stays silent when it is empty', () => {
    const bank = [
      { id: 'midterm-2#1', source: 'midterm-2', n: 1, text: 'a', added: '2026-07-27' },
      { id: 'midterm-2#2', source: 'midterm-2', n: 2, text: 'b', added: '2026-07-27', lastCorrect: '2026-07-27' },
    ];
    const ctx = buildBootstrapContext({ ...base, courseBank: bank });
    expect(ctx).toMatch(/Course bank: 2 problems from midterm-2 \(1 never answered\)/);
    expect(ctx).toMatch(/course_problems/);
    // An empty bank must not add a line — "Course bank: empty" in every session is noise.
    expect(buildBootstrapContext({ ...base, courseBank: [] })).not.toMatch(/Course bank/);
  });
  it('cold start in a teaching mode says research IS available but building the curriculum is not', () => {
    // An empty vault is the one case where a teaching mode gets web research (session.ts's
    // researchUnlocked) — so this line has to grant the one and withhold the other, or the tutor
    // either refuses a question it could have answered or tries to write pages it cannot write.
    const ctx = buildBootstrapContext({ ...base, mode: 'learn', emptyVault: true });
    expect(ctx).toMatch(/COLD START/);
    expect(ctx).toMatch(/web research/);
    expect(ctx).toMatch(/LEARN mode gives you web research/);
    expect(ctx).toMatch(/NO page-writing or\s+ingest tools/);
    expect(ctx).toMatch(/switch to freeform/);
  });
  it('cold start in freeform tells it to research and build instead', () => {
    const ctx = buildBootstrapContext({ ...base, mode: 'freeform', emptyVault: true });
    expect(ctx).toMatch(/COLD START/);
    expect(ctx).toMatch(/write_page/);
    expect(ctx).toMatch(/create_path/);
    expect(ctx).not.toMatch(/switch to freeform/);
  });
  it('omits the cold-start line entirely when the vault has pages', () => {
    expect(buildBootstrapContext({ ...base, emptyVault: false })).not.toMatch(/COLD START/);
    expect(buildBootstrapContext({ ...base })).not.toMatch(/COLD START/);
  });
  it('instructions forbid narrating block mechanics after a block tool call (docs/superpowers/'
    + 'plans/2026-07-21-coding-stage.md section C)', () => {
    const instructions = buildInstructions();
    expect(instructions).toMatch(/do not narrate block mechanics/i);
    expect(instructions).toMatch(/The\s+block is displayed/);
    expect(instructions).toMatch(/at most one sentence of NEW\s+pedagogical content/i);
  });
  it('bootstrap context includes lessons, mode framing, and anki lapses', () => {
    const ctx = buildBootstrapContext({
      mode: 'review',
      state: { 'chain-rule': { level: 'practicing' } },
      lessons: [{ slug: 'derivatives', title: 'Derivatives', reason: 'review-due', detail: 'decayed' }],
      reviewsDue: ['derivatives'],
      ankiLapses: [{ slug: 'chain-rule', count: 3 }],
    });
    expect(ctx).toMatch(/SESSION CONTEXT/);
    expect(ctx).toMatch(/review/i);
    expect(ctx).toMatch(/derivatives/);
    expect(ctx).toMatch(/chain-rule.*3 lapses/);
  });
});

it('a voice preference is injected as a style line — and absent when unset', () => {
  const base = { mode: 'learn' as const, state: {}, lessons: [], reviewsDue: [], ankiLapses: [] };
  const styled = buildBootstrapContext({ ...base, voice: 'high school, no jargon' });
  expect(styled).toContain('Teaching style the student asked for: high school, no jargon');
  expect(buildBootstrapContext(base)).not.toContain('Teaching style');
});
