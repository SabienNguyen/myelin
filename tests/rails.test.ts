import { describe, it, expect } from 'vitest';
import {
  fallbackQuickCheck, firstHeadingOrLine, generateRailsQuickCheck, generateRailsFeedback,
  nextRailsSeq, pickRailsItem, railsHistoryLines, trimToBudget,
  RAILS_PAGE_BUDGET, type WorkingSetMember,
} from '../src/server/rails.js';
import { textModel } from './mockModel.js';

const member = (over: Partial<WorkingSetMember>): WorkingSetMember => ({
  slug: 'page', title: 'Page', level: 'practicing', effective: 'practicing',
  lastEvidence: '2026-07-01T00:00:00Z', due: false, why: 'recent-evidence', ...over,
});

// A no-vault cfg: recordUsage returns early on an empty vault, so generation tests need no fs.
const cfg = { vault: '', models: { tutor: { model: 'test-model' } } } as any;

describe('pickRailsItem', () => {
  it('picks due members most-overdue-first, ahead of lessons and neighbors', () => {
    const members = [
      member({ slug: 'fresh-due', due: true, lastEvidence: '2026-07-20T00:00:00Z' }),
      member({ slug: 'stale-due', due: true, lastEvidence: '2026-06-01T00:00:00Z', effective: 'exposed' }),
      member({ slug: 'neighbor-page', why: 'neighbor:stale-due', lastEvidence: null, level: 'unseen', effective: 'unseen' }),
    ];
    const lessons = [{ slug: 'frontier-page', title: 'Frontier' }];
    const pick = pickRailsItem(members, lessons, new Set());
    expect(pick).toMatchObject({ slug: 'stale-due', reason: 'due', level: 'exposed' });
  });

  it('falls through to next_lessons when nothing is due, then to never-exercised neighbors', () => {
    const members = [
      member({ slug: 'solid', due: false }),
      member({ slug: 'nearby', why: 'neighbor:solid', lastEvidence: null, level: 'unseen', effective: 'unseen' }),
    ];
    expect(pickRailsItem(members, [{ slug: 'lesson-a', title: 'Lesson A' }], new Set()))
      .toMatchObject({ slug: 'lesson-a', reason: 'lesson', level: 'unseen' });
    expect(pickRailsItem(members, [], new Set()))
      .toMatchObject({ slug: 'nearby', reason: 'neighbor' });
  });

  it('skips items already staged this session at every rung', () => {
    const members = [
      member({ slug: 'due-a', due: true, lastEvidence: '2026-06-01T00:00:00Z' }),
      member({ slug: 'due-b', due: true, lastEvidence: '2026-06-10T00:00:00Z' }),
      member({ slug: 'nearby', why: 'neighbor:due-a', lastEvidence: null }),
    ];
    const lessons = [{ slug: 'lesson-a' }];
    expect(pickRailsItem(members, lessons, new Set(['due-a']))?.slug).toBe('due-b');
    expect(pickRailsItem(members, lessons, new Set(['due-a', 'due-b']))?.slug).toBe('lesson-a');
    expect(pickRailsItem(members, lessons, new Set(['due-a', 'due-b', 'lesson-a']))?.slug).toBe('nearby');
  });

  it('returns null when everything is staged — the exhaustion signal', () => {
    const members = [member({ slug: 'due-a', due: true })];
    expect(pickRailsItem(members, [{ slug: 'lesson-a' }], new Set(['due-a', 'lesson-a']))).toBeNull();
    expect(pickRailsItem([], [], new Set())).toBeNull();
  });

  it('an exercised neighbor is not a "never-exercised" neighbor', () => {
    const members = [
      member({ slug: 'worked', why: 'neighbor:solid', lastEvidence: '2026-07-01T00:00:00Z' }),
    ];
    expect(pickRailsItem(members, [], new Set())).toBeNull();
  });
});

describe('assemble budget', () => {
  it('caps the page body at RAILS_PAGE_BUDGET and marks the cut', () => {
    const body = 'x'.repeat(RAILS_PAGE_BUDGET + 500);
    const trimmed = trimToBudget(body);
    expect(trimmed.length).toBeLessThanOrEqual(RAILS_PAGE_BUDGET + '\n[page truncated]'.length);
    expect(trimmed.endsWith('[page truncated]')).toBe(true);
    expect(trimToBudget('short body')).toBe('short body');
  });

  it('history keeps only the last 4 text exchanges and drops block payloads', () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`, role: i % 2 ? 'assistant' : 'user',
      parts: [{ type: 'text', text: `line ${i}` }],
    })) as any[];
    messages.push({
      id: 'blk', role: 'assistant',
      parts: [{ type: 'tool-quick_check', toolCallId: 'rails-1', state: 'output-available', input: {}, output: {} }],
    } as any);
    const lines = railsHistoryLines(messages);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe('student: line 4');
    expect(lines[7]).toBe('tutor: line 11');
    expect(lines.join('\n')).not.toMatch(/quick_check/);
  });
});

describe('generateRailsQuickCheck', () => {
  const item = { slug: 'derivatives', title: 'Derivatives', level: 'unseen', reason: 'lesson' } as const;
  const page = { title: 'Derivatives', body: '# The derivative\nSlope at a point.' };
  const good = {
    question: 'What does a derivative measure?', mode: 'choice',
    choices: ['slope at a point', 'area under a curve', 'a running sum'],
    expected: 'slope at a point',
    framing: 'First contact — a wrong guess is useful.',
  };

  it('retries once with the rejection appended when expected is not among choices', async () => {
    let call = 0;
    const { model, prompts } = textModel(() => {
      call++;
      return JSON.stringify(call === 1 ? { ...good, expected: 'the slope' } : good);
    });
    const gen = await generateRailsQuickCheck({ model, cfg }, item, page, [], []);
    expect(gen).toMatchObject({ expected: 'slope at a point' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/rejected: expected "the slope" is not one of choices/);
  });

  it('falls back to the deterministic template question after two bad outputs', async () => {
    // Non-JSON replies make generateStructured throw (no tool call) — twice, then the template.
    const { model, prompts } = textModel('not json at all');
    const gen = await generateRailsQuickCheck({ model, cfg }, item, page, [], []);
    expect(prompts).toHaveLength(2);
    expect(gen.mode).toBe('choice');
    expect(gen.expected).toBe('The derivative'); // the page's first heading
    expect(gen.choices).toContain('The derivative');
    expect(gen.choices.length).toBeGreaterThanOrEqual(3);
  });

  it('grounds the prompt in the page and demands calibration framing on first contact', async () => {
    const { model, prompts } = textModel(JSON.stringify(good));
    await generateRailsQuickCheck({ model, cfg }, item, page, [{ slug: 'slopes', title: 'Slopes' }], ['student: hi']);
    expect(prompts[0]).toMatch(/Slope at a point\./);       // page body rides
    expect(prompts[0]).toMatch(/not expected to know this yet/); // rule 3 calibration framing
    expect(prompts[0]).toMatch(/NEVER append "and why\?"/); // choice mode forbids the why
    expect(prompts[0]).toMatch(/Slopes/);                    // analogy bridge named
    expect(prompts[0]).toMatch(/student: hi/);               // history line rides
  });
});

describe('generateRailsFeedback', () => {
  const graded = [{
    question: '2+2?', answer: '4',
    grade: { verdict: 'correct', source: 'mechanical', detail: 'exact match', evidence: [] } as any,
  }];

  it('returns the structured feedback and next signal', async () => {
    const { model, prompts } = textModel(JSON.stringify({ feedback: 'You picked "4".', next: 'continue' }));
    const fb = await generateRailsFeedback({ model, cfg }, graded);
    expect(fb).toEqual({ feedback: 'You picked "4".', next: 'continue' });
    expect(prompts[0]).toMatch(/Machine grade: correct — exact match/);
    expect(prompts[0]).toMatch(/only what the student actually did/); // rule 3a rides the prompt
  });

  it('falls back to reading the machine grade aloud with a stop-offer on a failed call', async () => {
    const { model } = textModel('still not json');
    const fb = await generateRailsFeedback({ model, cfg }, graded);
    expect(fb.next).toBe('stop-offer');
    expect(fb.feedback).toMatch(/correct \(exact match\)/);
  });
});

describe('rails ids and fallback seeds', () => {
  it('nextRailsSeq continues past the highest rails id in the thread', () => {
    const messages = [{
      id: 'a1', role: 'assistant',
      parts: [
        { type: 'tool-quick_check', toolCallId: 'rails-3', state: 'output-available', input: {}, output: {} },
        { type: 'tool-quick_check', toolCallId: 'not-rails-9', state: 'output-available', input: {}, output: {} },
      ],
    }] as any[];
    expect(nextRailsSeq(messages)).toBe(4);
    expect(nextRailsSeq([])).toBe(1);
  });

  it('firstHeadingOrLine prefers a heading, skips frontmatter fences, falls back to the title', () => {
    expect(firstHeadingOrLine('---\n\n# Heading here\nbody')).toBe('Heading here');
    expect(firstHeadingOrLine('plain opening line\nmore')).toBe('plain opening line');
    expect(fallbackQuickCheck('Empty Page', '').expected).toBe('Empty Page');
  });
});
