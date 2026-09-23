// The `chat` variant: a lean prompt for the default mode, with NONE of the tutor's forcing (no
// produce-something note, no named-topic note, no suggested-lesson push). Every case here is the
// mirror image of promptGating.test.ts and greetingOpening.test.ts, run against 'chat' instead of
// the tutor, plus the vocabulary (shared/commands.ts) the new mode rides in on.
import { describe, it, expect } from 'vitest';
import { buildInstructions, promptConditionTerms, buildBootstrapContext, MODES, type TurnFacts } from '../src/server/prompt.js';
import { MODE_COMMANDS, STANCE_COMMANDS, STUDY_COMMAND, COMMANDS, commandMode } from '../src/shared/commands.js';

const turn = (tools: string[], facts: string[] = []): TurnFacts => ({ tools: new Set(tools), facts: new Set(facts) });
// An ordinary chat turn's tools: vault reads plus evidence, none of which gate anything in this
// file — the baseline every gate table below adds one tool/fact on top of.
const CHAT_BASE = ['search', 'read_page', 'record_evidence'];

describe('buildInstructions(undefined, "chat") — the whole document', () => {
  it('with no turn, is every chat rule and no marker', () => {
    const full = buildInstructions(undefined, 'chat');
    expect(full).not.toMatch(/<!--/);
    for (const phrase of ['Answer what was asked', 'Ground before you recall',
      'Learning tools are offered, never forced', 'Blocks are tools — invoke them, never describe them',
      'Graded work, and only graded work, is evidence', 'Structured study is a separate mode',
      'Write maths as maths', 'Research like a librarian', 'Save what is worth keeping',
      'Name the literature', 'A quoted passage is an invitation to discuss the source']) {
      expect(full, phrase).toContain(phrase);
    }
  });

  it('a turn that satisfies every chat condition gets the same whole document', () => {
    const terms = promptConditionTerms('chat');
    const all = turn(terms.filter((t) => t.startsWith('tool:')).map((t) => t.slice(5)),
      terms.filter((t) => t.startsWith('fact:')).map((t) => t.slice(5)));
    expect(buildInstructions(all, 'chat')).toBe(buildInstructions(undefined, 'chat'));
  });

  it('keeps the unconditional core on the barest chat turn', () => {
    const bare = buildInstructions(turn(CHAT_BASE), 'chat');
    for (const phrase of ['Answer what was asked', 'Feedback describes only what the student actually did',
      'Text you wrote before a tool call has already been shown']) {
      expect(bare, phrase).toContain(phrase);
    }
  });

  // The whole reason this file exists: chat must carry none of the forcing that made "hi" resume
  // last session's topic, even on a turn open enough to satisfy every one of chat's OWN gates.
  it('carries none of the tutor-only forcing, however open the turn', () => {
    const wideOpen = buildInstructions(turn([...CHAT_BASE, 'web_search', 'read_url', 'write_page',
      'find_recent_papers', 'find_canonical_sources'], ['sources']), 'chat');
    for (const phrase of ['Teach one concept at a time', 'Let a win land', 'Probe before teaching',
      'ends in something the learner produces', 'Make the learner APPLY', 'A new subject needs a PATH',
      'Teach yourself before teaching a NEW subject',
      'After EVERY graded block result, call `record_evidence`']) {
      expect(wideOpen, phrase).not.toContain(phrase);
    }
  });

  it('the tutor variant is untouched by the new parameter', () => {
    const tutorDoc = buildInstructions();
    expect(buildInstructions(undefined, 'tutor')).toBe(tutorDoc);
    expect(tutorDoc).not.toContain('Myelin Chat Prompt');
    expect(tutorDoc).not.toContain('Structured study is a separate mode');
  });
});

describe('chat condition terms are real', () => {
  it('every chat condition is a well-formed tool/fact term (the unknown-term throw applies here too)', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../src/server/chat-system-prompt.md', import.meta.url), 'utf8');
    expect(text).not.toMatch(/<!-- when: (?!(?:(?:tool|fact):[\w]+\|?)+ -->)/);
  });

  it("promptConditionTerms('chat') are the chat file's own terms, not the tutor file's", () => {
    const terms = promptConditionTerms('chat');
    expect(terms.sort()).toEqual([
      'fact:sources', 'tool:find_canonical_sources', 'tool:find_recent_papers',
      'tool:read_url', 'tool:web_search', 'tool:write_page',
    ].sort());
    expect(terms).not.toContain('tool:quick_check'); // tutor-only condition — separate cache per variant
  });
});

describe('each chat gate, both ways', () => {
  const cases: [string, string, TurnFacts, TurnFacts][] = [
    ['research via web_search', 'Research like a librarian', turn([...CHAT_BASE, 'web_search']), turn(CHAT_BASE)],
    ['research via read_url', 'Research like a librarian', turn([...CHAT_BASE, 'read_url']), turn(CHAT_BASE)],
    ['write_page', 'Save what is worth keeping', turn([...CHAT_BASE, 'write_page']), turn(CHAT_BASE)],
    ['recent papers', 'Name the literature', turn([...CHAT_BASE, 'find_recent_papers']), turn(CHAT_BASE)],
    ['canonical sources', 'Name the literature', turn([...CHAT_BASE, 'find_canonical_sources']), turn(CHAT_BASE)],
    ['quoted passage', 'A quoted passage is an invitation', turn(CHAT_BASE, ['sources']), turn(CHAT_BASE)],
  ];
  it.each(cases)('%s', (_name, phrase, needs, doesNot) => {
    expect(buildInstructions(needs, 'chat')).toContain(phrase);
    expect(buildInstructions(doesNot, 'chat')).not.toContain(phrase);
  });
});

describe('FRAMING.chat', () => {
  it('frames chat as following the student, not running a lesson plan', () => {
    const ctx = buildBootstrapContext({ state: {}, lessons: [], reviewsDue: [], ankiLapses: [], mode: 'chat' });
    expect(ctx).toContain('Mode: CHAT. Follow the student. Learning tools are there if they want them; nothing here is a lesson plan.');
  });
});

describe('chat bootstrap', () => {
  const base = { state: {}, ankiLapses: [] as { slug: string; count: number }[] };

  it('greeting: greets briefly, asks what to explore, never mentions lessons/reviews/goals as an ask', () => {
    const ctx = buildBootstrapContext({
      ...base, mode: 'chat', greeting: true,
      lessons: [{ slug: 'derivatives', title: 'Derivatives', reason: 'review-due', detail: 'due today' }],
      reviewsDue: ['derivatives'],
      goal: { kind: 'page', slug: 'chain-rule', title: 'Chain Rule' },
    });
    expect(ctx).toContain('Mode: CHAT. The student opened with a greeting — greet them back briefly '
      + 'and ask what they would like to explore. Do not bring up lessons, reviews or goals unless they ask.');
    // The instructions this replaces — the ones that made "hi" resume last session's topic.
    expect(ctx).not.toContain('Teach the next suggested lesson');
    expect(ctx).not.toContain('opened with a greeting and nothing else');
    expect(ctx).not.toContain('Suggested lessons:');
    expect(ctx).not.toContain('Reviews due:');
    expect(ctx).not.toContain('Anki trouble:');
    expect(ctx).not.toContain('Active goal:');
    expect(ctx).toContain('For reference only — never bring it up unprompted:');
  });

  it('not a greeting: ordinary chat framing, same reference-only line', () => {
    const ctx = buildBootstrapContext({ ...base, mode: 'chat', lessons: [], reviewsDue: [] });
    expect(ctx).toContain('Mode: CHAT. Follow the student.');
    expect(ctx).not.toContain('opened with a greeting');
    expect(ctx).not.toContain('Teach the next suggested lesson');
    expect(ctx).not.toContain('Suggested lessons:');
    expect(ctx).toContain('For reference only — never bring it up unprompted:');
  });

  it('the reference line names the count, the first two suggestions, and the goal title', () => {
    const ctx = buildBootstrapContext({
      ...base, mode: 'chat',
      lessons: [
        { slug: 'derivatives', title: 'Derivatives', reason: 'review-due', detail: 'due today' },
        { slug: 'limits', title: 'Limits', reason: 'next', detail: 'natural next step' },
        { slug: 'integrals', title: 'Integrals', reason: 'next', detail: 'later' },
      ],
      reviewsDue: ['derivatives', 'limits'],
      goal: { kind: 'page', slug: 'chain-rule', title: 'Chain Rule' },
    });
    expect(ctx).toContain('For reference only — never bring it up unprompted: 2 reviews due; '
      + 'next suggested: derivatives, limits; active goal: Chain Rule.');
  });

  it('falls back to "none" for reviews, suggestions and goal, and to the slug when a goal has no title', () => {
    const empty = buildBootstrapContext({ ...base, mode: 'chat', lessons: [], reviewsDue: [] });
    expect(empty).toContain('For reference only — never bring it up unprompted: 0 reviews due; '
      + 'next suggested: none; active goal: none.');
    const slugGoal = buildBootstrapContext({
      ...base, mode: 'chat', lessons: [], reviewsDue: [], goal: { kind: 'page', slug: 'chain-rule' },
    });
    expect(slugGoal).toContain('active goal: chain-rule.');
  });
});

describe('non-chat bootstrap: byte-identical to before this change', () => {
  // Captured from buildBootstrapContext on the pre-chat code, then hand-verified against its
  // source line by line. If this ever fails, some other mode's harness-visible context changed.
  const EXPECTED_LEARN = [
    'SESSION CONTEXT (auto-injected by harness — not visible to the student):',
    'Mode: LEARN. Teach the next suggested lesson.',
    'Teaching style the student asked for: be terse and use lots of examples. Honor it in tone, pace and\nvocabulary — it changes HOW you teach, never what counts as evidence.',
    'Student state: {"level":3}',
    'Suggested lessons: derivatives (review-due: due today); limits (next: natural next step)',
    'Reviews due: derivatives',
    'Anki trouble: chain-rule — 2 lapses this week; probe for misconceptions',
    'Course bank: 2 problems from mit-1801 (1 never answered) — fetch with course_problems and drill them verbatim.',
    'Active goal: path "Calculus I" (calc-1) — 4/10 pages known, resume at limits. Teach toward this unless the student asks otherwise.',
  ].join('\n');
  const EXPECTED_LEARN_GREETING = [
    'SESSION CONTEXT (auto-injected by harness — not visible to the student):',
    'Mode: LEARN. The student opened with a greeting and nothing else — they have NOT said what '
      + 'they want to do. Greet them back in one line, say briefly what is waiting (what is due, '
      + 'what you would suggest next, where the goal stands), and name ONE specific next step as a '
      + 'question. Do not stage a block and do not start teaching until they answer. If they want '
      + 'something else, that answer is where you find out.',
    'Teaching style the student asked for: be terse and use lots of examples. Honor it in tone, pace and\nvocabulary — it changes HOW you teach, never what counts as evidence.',
    'Student state: {"level":3}',
    'Suggested lessons: derivatives (review-due: due today); limits (next: natural next step)',
    'Reviews due: derivatives',
    'Anki trouble: chain-rule — 2 lapses this week; probe for misconceptions',
    'Course bank: 2 problems from mit-1801 (1 never answered) — fetch with course_problems and drill them verbatim.',
    'Active goal: path "Calculus I" (calc-1) — 4/10 pages known, resume at limits. Teach toward this unless the student asks otherwise.',
  ].join('\n');
  const EXPECTED_FREEFORM_EMPTY = [
    'SESSION CONTEXT (auto-injected by harness — not visible to the student):',
    'Mode: FREEFORM. Follow the student; still record evidence.',
    'Student state: {}',
    'Suggested lessons: none',
    'Reviews due: none',
    'Anki trouble: none',
    'Active goal: none. If the student names something they want to learn, offer to set it as a goal '
      + '(a curated path via create_path in freeform mode) so progress becomes trackable.',
    'COLD START: the vault has no pages yet. Research the subject the student names, then write its '
      + 'first pages (write_page) and a curated path (create_path) before teaching.',
  ].join('\n');

  const richArgs = {
    state: { level: 3 },
    lessons: [
      { slug: 'derivatives', title: 'Derivatives', reason: 'review-due', detail: 'due today' },
      { slug: 'limits', title: 'Limits', reason: 'next', detail: 'natural next step' },
    ],
    reviewsDue: ['derivatives'],
    ankiLapses: [{ slug: 'chain-rule', count: 2 }],
    goal: { kind: 'path' as const, slug: 'calc-1', title: 'Calculus I', known: 4, total: 10, nextSlug: 'limits' },
    emptyVault: false,
    courseBank: [
      { id: 'mit1801#1', source: 'mit-1801', n: 1, text: 'Find the derivative...', added: '2026-01-01' },
      { id: 'mit1801#2', source: 'mit-1801', n: 2, text: 'Evaluate the limit...', added: '2026-01-01', lastCorrect: '2026-01-02' },
    ],
    voice: 'be terse and use lots of examples',
  };

  it('learn mode, ordinary turn', () => {
    expect(buildBootstrapContext({ ...richArgs, mode: 'learn', greeting: false })).toBe(EXPECTED_LEARN);
  });
  it('learn mode, greeting', () => {
    expect(buildBootstrapContext({ ...richArgs, mode: 'learn', greeting: true })).toBe(EXPECTED_LEARN_GREETING);
  });
  it('freeform mode, empty vault, no optional fields', () => {
    expect(buildBootstrapContext({
      mode: 'freeform', state: {}, lessons: [], reviewsDue: [], ankiLapses: [], emptyVault: true,
    })).toBe(EXPECTED_FREEFORM_EMPTY);
  });
});

describe('shared/commands.ts — chat vocabulary', () => {
  it('MODE_COMMANDS mirrors MODES, including the new chat member', () => {
    expect(new Set(MODE_COMMANDS)).toEqual(new Set(MODES));
    expect(MODE_COMMANDS).toContain('chat');
  });

  it('STUDY_COMMAND is "study" and rides in COMMANDS', () => {
    expect(STUDY_COMMAND).toBe('study');
    expect(COMMANDS).toContain(STUDY_COMMAND);
  });

  it('commandMode: study routes to the learn tutor', () => {
    expect(commandMode(STUDY_COMMAND)).toBe('learn');
  });

  it('commandMode: every mode command routes to itself', () => {
    for (const c of MODE_COMMANDS) expect(commandMode(c)).toBe(c);
  });

  it('commandMode: stance commands and write set no mode', () => {
    for (const c of [...STANCE_COMMANDS, 'write' as const]) expect(commandMode(c)).toBeUndefined();
  });
});
