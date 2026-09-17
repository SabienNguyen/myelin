// The tutor's rules are selected per turn. Every gate below is asserted in BOTH directions: each
// rule exists because a model misbehaved without it, so "present when needed" matters exactly as
// much as "absent when not" — a gate keyed to the wrong condition brings its bug back silently.
import { describe, it, expect, beforeAll } from 'vitest';
import { buildInstructions, promptConditionTerms, type TurnFacts } from '../src/server/prompt.js';

let session: typeof import('../src/server/session.js');
beforeAll(async () => { session = await import('../src/server/session.js'); });

const turn = (tools: string[], facts: string[] = []): TurnFacts => ({ tools: new Set(tools), facts: new Set(facts) });
const tok = (s: string) => Math.round(s.length / 4);
const TEACH = ['read_page', 'search', 'get_student_state', 'record_evidence', 'next_lessons', 'find_analogies', 'list_paths', 'read_path'];
const BLOCKS = ['quick_check', 'structured_check', 'quiz', 'math_scratchpad', 'writing_draft', 'label_diagram', 'pronounce', 'watch_video', 'open_source', 'offer_write', 'speak'];
const FRONTIER = ['find_recent_papers', 'find_canonical_sources'];

describe('buildInstructions — the whole document', () => {
  it('with no turn, is every rule and no marker', () => {
    const full = buildInstructions();
    expect(full).not.toMatch(/<!--/);
    for (const phrase of ['Teach yourself before teaching a NEW subject', 'A new subject needs a PATH',
      'Make the learner APPLY', 'Banked course problems are drilled VERBATIM', 'Teaching a language']) {
      expect(full).toContain(phrase);
    }
  });

  it('a turn that satisfies every condition gets the same whole document', () => {
    const terms = promptConditionTerms();
    const all = turn(terms.filter((t) => t.startsWith('tool:')).map((t) => t.slice(5)),
      terms.filter((t) => t.startsWith('fact:')).map((t) => t.slice(5)));
    expect(buildInstructions(all)).toBe(buildInstructions());
  });

  // The rules nobody may lose, on the barest turn there is.
  it('keeps the unconditional core on every turn', () => {
    const bare = buildInstructions(turn([]));
    for (const phrase of ['invoke them, never describe them', 'Teach one concept at a time', 'Let a win land',
      'Probe before teaching', 'After EVERY graded block result, call `record_evidence`',
      'do not narrate block mechanics', 'Re-probe recorded misconceptions']) {
      expect(bare, phrase).toContain(phrase);
    }
  });
});

describe('condition terms are real', () => {
  it('every tool: names a tool the harness can actually offer', () => {
    const offered = new Set([
      ...session.turnBlockTools(false, ['stream-consumer — demo'], false, [], true).map((t) => t.name),
      ...session.buildFrontierTools().map((t) => t.name),
      'create_path', 'write_page', // engram's own, pinned by crossRepoContract.test.ts
    ]);
    for (const term of promptConditionTerms().filter((t) => t.startsWith('tool:'))) {
      expect(offered, term).toContain(term.slice(5));
    }
  });

  it('every fact: is one turnFacts can produce', () => {
    const everything = session.turnFacts({
      tools: ['web_search'], mode: 'review', emptyVault: true, bankSize: 3, readingSource: true,
      sources: [{ origin: { kind: 'video' } }],
      messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: "Run today's session, in this order:\n1. [new] vietnamese tones" }] }] as any,
    });
    for (const term of promptConditionTerms().filter((t) => t.startsWith('fact:'))) {
      expect(everything.facts, term).toContain(term.slice(5));
    }
  });

  it('an unknown condition throws rather than dropping a rule forever', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../src/server/tutor-system-prompt.md', import.meta.url), 'utf8');
    expect(text).not.toMatch(/<!-- when: (?!(?:(?:tool|fact):[\w]+\|?)+ -->)/);
  });
});

describe('each gate, both ways', () => {
  const cases: [string, string, TurnFacts, TurnFacts][] = [
    ['13 research', 'Teach yourself before teaching a NEW subject', turn(TEACH, ['research']), turn(TEACH)],
    ['13 research unlock', 'your memory has a gap here', turn(TEACH, ['research']), turn(TEACH)],
    ['13 frontier', 'call `find_recent_papers` FIRST', turn(FRONTIER), turn(TEACH)],
    ['13 librarian', 'LIBRARIAN, not author', turn(FRONTIER), turn(TEACH)],
    ['13 quoted passage', 'A quoted passage is an invitation', turn(TEACH, ['sources']), turn(TEACH)],
    ['13 never re-open', 'Never open what they are already reading', turn(TEACH, ['sources']), turn(TEACH)],
    ['13 video stamps', 'Video transcripts are lectures', turn(TEACH, ['videoSources']), turn(TEACH, ['sources'])],
    ['13 language', 'Teaching a language', turn(TEACH, ['language']), turn([...TEACH, ...BLOCKS])],
    ['13 offer_write', '`offer_write` is for the narrow remaining case', turn(['offer_write']), turn(TEACH)],
    ['7a path', 'A new subject needs a PATH', turn(['write_page']), turn(TEACH)],
    ['7a cold start', 'A new subject needs a PATH', turn(TEACH, ['emptyVault']), turn(TEACH)],
    ['7b source order', "taught in the SOURCE's order", turn(TEACH, ['sources']), turn(TEACH)],
    ['2a plan', 'execute it as one', turn(TEACH, ['plan']), turn(TEACH, ['review'])],
    ['2a-i transfer on review', 'change the surface', turn(TEACH, ['review']), turn(TEACH)],
    ['2a-i transfer in a plan', 'change the surface', turn(TEACH, ['plan']), turn(TEACH)],
    ['2b course bank', 'drilled VERBATIM', turn(TEACH, ['courseBank']), turn(TEACH)],
    ['10b instrument', 'Match the instrument to the work', turn(['quick_check']), turn(TEACH)],
    ['10c produce', 'ends in something the learner produces', turn(['quick_check']), turn(TEACH)],
    ['11a apply', 'Make the learner APPLY', turn(['structured_check']), turn(['quick_check'])],
    ['11 code', 'prefer `code_exercise` over `quiz`', turn(['code_exercise']), turn(BLOCKS)],
    ['11b rubrics', 'Essay subjects get RUBRICS', turn(['writing_draft']), turn(['quick_check'])],
    ['11c maths', 'Write maths as maths', turn(['quick_check']), turn(TEACH)],
    ['11d pictures', 'Subjects that are pictures', turn(['label_diagram']), turn(['quick_check'])],
    ['11e video snippets', 'Assign videos as SNIPPETS', turn(['watch_video']), turn(['quick_check'])],
  ];
  it.each(cases)('%s', (_name, phrase, needs, doesNot) => {
    expect(buildInstructions(needs)).toContain(phrase);
    expect(buildInstructions(doesNot)).not.toContain(phrase);
  });

  // 10c says every teaching turn ends in a block; rule 1a says a grading turn must NOT stage one,
  // and session.ts withholds the block tools there. Sent together they contradicted each other.
  it('a grading turn is not told to stage blocks it has been denied', () => {
    const grading = buildInstructions(turn([...TEACH, 'open_source', 'offer_write', 'speak']));
    expect(grading).not.toContain('ends in something the learner produces');
    expect(grading).not.toContain('Make the learner APPLY');
    expect(grading).toContain('Let a win land');
  });
});

describe('what it buys', () => {
  it('a plain teaching turn carries well under two thirds of the full prompt', () => {
    const full = tok(buildInstructions());
    const teaching = tok(buildInstructions(turn([...TEACH, ...BLOCKS, ...FRONTIER])));
    const grading = tok(buildInstructions(turn([...TEACH, ...FRONTIER, 'open_source', 'offer_write', 'speak'])));
    console.log(`prompt tokens ~ full ${full} · teaching ${teaching} · grading ${grading}`);
    expect(teaching).toBeLessThan(full * 0.66);
    expect(grading).toBeLessThan(full * 0.45);
  });
});

describe('turnFacts', () => {
  const user = (text: string) => ({ id: 'u', role: 'user', parts: [{ type: 'text', text }] }) as any;
  const base = { tools: [] as string[], mode: 'learn', emptyVault: false, bankSize: 0, sources: [], readingSource: false, messages: [user('teach me derivatives')] };

  it('a plain turn has no facts at all', () => {
    expect([...session.turnFacts(base).facts]).toEqual([]);
  });
  it('a session plan stays a plan for the turns that work through it', () => {
    const messages = [user("Run today's session, in this order, one item at a time:\n1. [review] limits"), user('slope at a point')];
    expect(session.turnFacts({ ...base, messages }).facts.has('plan')).toBe(true);
  });
  it('research follows the tools, not the mode', () => {
    expect(session.turnFacts({ ...base, tools: ['read_url'] }).facts.has('research')).toBe(true);
    expect(session.turnFacts({ ...base, mode: 'freeform' }).facts.has('research')).toBe(false);
  });
  it('language is read from what the student has said, anywhere in the thread', () => {
    const messages = [user('I want to learn Vietnamese'), user('ok next')];
    expect(session.turnFacts({ ...base, messages }).facts.has('language')).toBe(true);
    expect(session.turnFacts(base).facts.has('language')).toBe(false);
  });
  it('a video source is also a source; a PDF is not a video', () => {
    const video = session.turnFacts({ ...base, sources: [{ origin: { kind: 'video' } }] }).facts;
    expect([...video].sort()).toEqual(['sources', 'videoSources']);
    expect([...session.turnFacts({ ...base, sources: [{ origin: { kind: 'file' } }] }).facts]).toEqual(['sources']);
  });
});

describe('toolFitsTurn — subject-specific schemas ride only the turns that can use them', () => {
  const plain = { language: false, research: false, hasSources: false, hasVideoSources: false, lastUserText: 'teach me the chain rule' };
  const fits = (name: string, over: Partial<typeof plain> = {}) => session.toolFitsTurn(name, { ...plain, ...over });

  it('a calculus turn carries no pronunciation, video or literature tools', () => {
    for (const name of ['pronounce', 'speak', 'find_video', 'video_transcript', 'watch_video',
      'find_recent_papers', 'find_canonical_sources', 'paper_references']) {
      expect(fits(name), name).toBe(false);
    }
  });

  it('never withholds the core instruments', () => {
    for (const name of ['quick_check', 'structured_check', 'quiz', 'math_scratchpad', 'writing_draft',
      'code_exercise', 'label_diagram', 'open_source', 'offer_write', 'record_evidence', 'read_page', 'write_page']) {
      expect(fits(name), name).toBe(true);
    }
  });

  it('a language subject gets to be heard and spoken', () => {
    expect(fits('speak', { language: true })).toBe(true);
    expect(fits('pronounce', { language: true })).toBe(true);
  });

  it('asking for a video, or already having one, brings the video tools', () => {
    expect(fits('find_video', { lastUserText: 'is there a good video on this?' })).toBe(true);
    expect(fits('watch_video', { hasVideoSources: true })).toBe(true);
    expect(fits('video_transcript', { research: true })).toBe(true);
  });

  it('asking what is new, or what to read, brings the literature tools', () => {
    expect(fits('find_recent_papers', { lastUserText: "what's the latest on speculative decoding?" })).toBe(true);
    expect(fits('find_canonical_sources', { lastUserText: 'what should I read first?' })).toBe(true);
    expect(fits('find_recent_papers', { research: true })).toBe(true);
    expect(fits('paper_references', { hasSources: true })).toBe(true);
  });
});
