import { describe, it, expect } from 'vitest';
import { buildHelpPrompt, HELP_SYSTEM_PROMPT, type HelpRungContext } from '../src/server/helpPrompt.js';

const baseRung: HelpRungContext = {
  template: 'full_body',
  artifactId: 'stream-consumer',
  visiblePre: 'function consumeStream(response) {',
  visiblePost: '}',
  contextLine: 'decode an SSE stream into discrete token events',
};

describe('buildHelpPrompt', () => {
  it('includes the learner-visible fields: pattern, visible code, draft, failures, vault page, question', () => {
    const { prompt } = buildHelpPrompt({
      pattern: 'stream-consumer',
      rung: baseRung,
      draft: 'const reader = response.body.getReader();',
      failures: ['handles a null body', 'stops at [DONE]'],
      vaultPage: 'A stream consumer decodes an incremental HTTP body.',
      question: 'why does the null body test still fail?',
    });
    expect(prompt).toContain('stream-consumer');
    expect(prompt).toContain('full_body');
    expect(prompt).toContain('function consumeStream(response) {');
    expect(prompt).toContain('const reader = response.body.getReader();');
    expect(prompt).toContain('handles a null body');
    expect(prompt).toContain('stops at [DONE]');
    expect(prompt).toContain('A stream consumer decodes an incremental HTTP body.');
    expect(prompt).toContain('why does the null body test still fail?');
  });

  it('tolerates a missing vault page without throwing, and says so plainly', () => {
    const { prompt } = buildHelpPrompt({
      pattern: 'stream-consumer', rung: baseRung, draft: '', failures: [],
      question: 'where do I start?',
    });
    expect(prompt).toContain('No vault page exists for this pattern yet.');
  });

  it('handles an empty draft and no failures without throwing', () => {
    const { prompt } = buildHelpPrompt({
      pattern: 'stream-consumer', rung: baseRung, draft: '   ', failures: [],
      question: 'what should I write first?',
    });
    expect(prompt).toContain('(empty — nothing written yet)');
    expect(prompt).toMatch(/No failing tests reported/);
  });

  it('system prompt enforces escalating proximity hints, never-complete-code, word cap, no praise/emoji', () => {
    expect(HELP_SYSTEM_PROMPT).toMatch(/CONCEPT/);
    expect(HELP_SYSTEM_PROMPT).toMatch(/STRATEGY/);
    expect(HELP_SYSTEM_PROMPT).toMatch(/STRUCTURE/);
    expect(HELP_SYSTEM_PROMPT).toMatch(/never write, dictate, or complete/i);
    expect(HELP_SYSTEM_PROMPT).toMatch(/180 words/);
    expect(HELP_SYSTEM_PROMPT).toMatch(/no praise/i);
    expect(HELP_SYSTEM_PROMPT).toMatch(/no emoji/i);
  });

  // Answer-integrity invariant (mechanical, not prompt-level): HelpRungContext has no
  // `reference_answer` field, so buildHelpPrompt has no field to read it from even if a careless
  // caller forwards the wire Rung object (which DOES carry reference_answer) straight through as
  // `rung` via a type-erasing cast. This is the strongest form of the proof — it holds regardless
  // of what the caller passes in, not just for well-typed callers.
  it('never echoes a reference_answer into the built prompt, even if a caller forwards it', () => {
    const SENTINEL = 'REFERENCE_SOLUTION_SENTINEL_9f3a1c';
    const rungWithLeakedAnswer = {
      ...baseRung,
      reference_answer: SENTINEL, // extra prop a careless caller might forward — must be ignored
    } as unknown as HelpRungContext;

    const { system, prompt } = buildHelpPrompt({
      pattern: 'stream-consumer',
      rung: rungWithLeakedAnswer,
      draft: 'let x = 1;',
      failures: ['some test'],
      vaultPage: 'reference vault content',
      question: 'why does it fail?',
    });

    expect(system).not.toContain(SENTINEL);
    expect(prompt).not.toContain(SENTINEL);
  });

  // Cross-turn escalation. The concept -> strategy -> structure ladder already existed, but the
  // route was stateless, so it could only run INSIDE one reply: a learner who was still stuck and
  // asked again got a fresh concept-level nudge with no signal the last one had not landed.
  describe('prior hints (escalation across turns)', () => {
    const base = {
      pattern: 'stream-consumer',
      rung: baseRung,
      draft: 'let x = 1;',
      failures: ['reassembles a split line'],
      question: 'still not working',
    };

    it('renders prior hints in order and tells the model the learner is still stuck', () => {
      const { prompt } = buildHelpPrompt({ ...base, priorHints: ['think about buffering', 'the buffer must outlive the loop'] });
      expect(prompt).toMatch(/1\. think about buffering/);
      expect(prompt).toMatch(/2\. the buffer must outlive the loop/);
      expect(prompt).toMatch(/still stuck, so go further than the last one/i);
    });

    it('says so explicitly when no hints have been given yet', () => {
      const { prompt } = buildHelpPrompt(base);
      expect(prompt).toMatch(/No hints have been given for this exercise yet/i);
    });

    it('treats an empty array the same as absent', () => {
      expect(buildHelpPrompt({ ...base, priorHints: [] }).prompt)
        .toMatch(/No hints have been given for this exercise yet/i);
    });

    it('the system prompt instructs escalation rather than rephrasing', () => {
      const { system } = buildHelpPrompt(base);
      expect(system).toMatch(/do not restate or rephrase/i);
      expect(system).toMatch(/at least one level higher/i);
      // The no-code-writing invariant must survive the escalation rule — the highest level still
      // names the wrong line, it does not supply the replacement.
      expect(system).toMatch(/do not write the/i);
    });
  });
});
