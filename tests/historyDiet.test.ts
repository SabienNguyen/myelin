import { describe, it, expect } from 'vitest';
import { dietUiMessages } from '../src/server/historyDiet.js';
import type { UIMessage } from '../src/shared/uiMessages.js';

const gradedBlock = (toolCallId: string, extra: { input?: object; output?: object } = {}) => ({
  type: 'tool-quick_check' as const,
  toolCallId,
  state: 'output-available' as const,
  input: { question: 'What is a derivative?', mode: 'choice', choices: ['slope', 'area'], ...extra.input },
  output: { answer: 'slope', grading: { verdict: 'correct', source: 'mechanical', detail: 'exact match' }, ...extra.output },
});

const asMessages = (parts: object[]): UIMessage[] => [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
  { id: 'a1', role: 'assistant', parts: parts as UIMessage['parts'] },
];

describe('dietUiMessages', () => {
  it('compacts an old graded block to a verdict line and leaves kept ids full', () => {
    const msgs = asMessages([gradedBlock('old'), gradedBlock('fresh')]);
    const out = dietUiMessages(msgs, new Set(['fresh']));
    const [oldPart, freshPart] = out[1].parts as any[];
    expect(oldPart.input).toEqual((msgs[1].parts[0] as any).input);
    expect(oldPart.input.question).toBe('What is a derivative?');
    expect(oldPart.input).not.toHaveProperty('compacted');
    expect(oldPart.output).toEqual({ compacted: true, answer: 'slope', verdict: 'correct', detail: 'exact match' });
    expect(freshPart.input.choices).toEqual(['slope', 'area']);
    expect(freshPart.output.grading.verdict).toBe('correct');
  });

  it('caps long payloads — a code submission compacts to its first 160 chars, and the oversized starter does not ride along', () => {
    const code = 'def f(x):\n    return x * 2\n'.repeat(40);
    const msgs = asMessages([{
      type: 'tool-code_exercise', toolCallId: 'c1', state: 'output-available',
      input: { prompt: 'Double it', starter: code },
      output: { code, grading: { verdict: 'correct', source: 'mechanical', detail: 'tests passed' } },
    }]);
    const part = (dietUiMessages(msgs, new Set())[1].parts as any[])[0];
    expect(part.output.answer.length).toBeLessThanOrEqual(161); // cap + ellipsis
    expect(part.output.answer.endsWith('…')).toBe(true);
    // Input keeps its original ARGUMENT SHAPE, so an over-long literal argument (the starter)
    // must be trimmed in place rather than dropped — trim strings, preserve keys.
    expect(JSON.stringify(part).length).toBeLessThan(600);
  });

  it('keeps the latest submitted writing draft intact for revision without inventing input fields', () => {
    const draft = (toolCallId: string, text: string) => ({
      type: 'tool-writing_draft', toolCallId, state: 'output-available',
      input: { prompt: 'Explain the tradeoff', rubric: ['State the cost', 'State the benefit'] },
      output: { draft: text, grading: { verdict: 'incorrect', detail: 'Explain the cost further' } },
    });
    const old = draft('old-draft', 'Earlier explanation. '.repeat(30));
    const latest = draft('latest-draft', 'Current explanation. '.repeat(30) + 'Important final paragraph.');
    const msgs = asMessages([old, latest, gradedBlock('later-quiz')]);
    msgs.push({ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Let me revise my explanation' }] });
    const before = JSON.stringify(msgs);
    const out = dietUiMessages(msgs, new Set());
    const parts = out[1].parts as any[];
    expect(parts[1]).toBe(latest);
    expect(parts[1].output.draft).toBe(latest.output.draft);
    expect(parts[0].output.answer.length).toBeLessThanOrEqual(161);
    expect(parts[0].input).toEqual(old.input);
    expect(parts[0].input).not.toHaveProperty('priorDraft');
    expect(JSON.stringify(msgs)).toBe(before);
  });

  it('never touches ungraded outputs, paused blocks, non-block tools, or user messages', () => {
    const msgs = asMessages([
      // Paused block: no output yet — the resubmit will supply it.
      { type: 'tool-quick_check', toolCallId: 'p1', state: 'input-available', input: { question: 'q' } },
      // Output without grading (a UI tool ack).
      { type: 'tool-open_source', toolCallId: 'u1', state: 'output-available', input: { title: 'Ch 1' }, output: { opened: true } },
      // A non-block server tool result.
      { type: 'tool-record_evidence', toolCallId: 'r1', state: 'output-available', input: { slug: 's' }, output: { ok: true } },
    ]);
    const out = dietUiMessages(msgs, new Set());
    expect(out[1]).toBe(msgs[1]); // untouched message shared by reference
    expect(out[0]).toBe(msgs[0]);
  });

  it('stubs file parts on EARLIER user messages, keeping only the last user message\'s attachments', () => {
    const msgs: UIMessage[] = [
      {
        id: 'u1', role: 'user',
        parts: [
          { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,aaaa', filename: 'shot.png' },
          { type: 'file', mediaType: 'application/pdf', url: 'data:application/pdf;base64,bbbb' },
          { type: 'text', text: 'what is this?' },
        ],
      },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'a diagram' }] },
      {
        id: 'u2', role: 'user',
        parts: [
          { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,cccc', filename: 'next.png' },
          { type: 'text', text: 'and this?' },
        ],
      },
    ];
    const out = dietUiMessages(msgs, new Set());
    // Earlier attachments: base64 gone, a one-line stub in position (filename, or mediaType
    // when the part never carried one).
    expect(out[0]!.parts).toEqual([
      { type: 'text', text: '[image attached earlier: shot.png]' },
      { type: 'text', text: '[file attached earlier: application/pdf]' },
      { type: 'text', text: 'what is this?' },
    ]);
    // The LAST user message — what this turn is about — keeps its files, by reference.
    expect(out[2]).toBe(msgs[2]);
    expect(out[1]).toBe(msgs[1]);
  });

  it('is deterministic: the same history compacts identically on every call', () => {
    const msgs = asMessages([gradedBlock('old')]);
    const a = JSON.stringify(dietUiMessages(msgs, new Set()));
    const b = JSON.stringify(dietUiMessages(msgs, new Set()));
    expect(a).toBe(b);
  });
});

describe('dietUiMessages — reading tools', () => {
  // One turn = one user message plus its assistant reply.
  const turn = (n: number, parts: object[]): UIMessage[] => [
    { id: `u${n}`, role: 'user', parts: [{ type: 'text', text: `turn ${n}` }] },
    { id: `a${n}`, role: 'assistant', parts: parts as UIMessage['parts'] },
  ];

  it('compacts a reading tool result older than the last two turns to a one-line stub', () => {
    const msgs: UIMessage[] = [
      ...turn(1, [{
        type: 'tool-read_page', toolCallId: 'rp1', state: 'output-available',
        input: { slug: 'derivatives' }, output: { page: { body: 'x'.repeat(500) } },
      }]),
      ...turn(2, [{ type: 'text', text: 'ok' }]),
      ...turn(3, [{ type: 'text', text: 'ok' }]),
    ];
    const out = dietUiMessages(msgs, new Set());
    const part = (out[1].parts as any[])[0];
    expect(part.output).toEqual({ compacted: true, note: 'read_page(derivatives)' });
    expect(part.input).toEqual({ slug: 'derivatives' }); // the tiny input rides untouched
  });

  it('keeps a reading tool result from the last two turns full', () => {
    const msgs: UIMessage[] = [
      ...turn(1, [{ type: 'text', text: 'ok' }]),
      ...turn(2, [{
        type: 'tool-video_transcript', toolCallId: 'vt1', state: 'output-available',
        input: { url: 'https://youtu.be/x' }, output: { transcript: 'full text' },
      }]),
      ...turn(3, [{ type: 'text', text: 'ok' }]),
    ];
    const out = dietUiMessages(msgs, new Set());
    expect(out[3]).toBe(msgs[3]); // untouched by reference
  });

  it('names slug/url/query/topic per tool in the stub; course_problems has none to name', () => {
    const cases: [string, object, string][] = [
      ['tool-read_page', { slug: 'arith' }, 'read_page(arith)'],
      ['tool-video_transcript', { url: 'https://y/z' }, 'video_transcript(https://y/z)'],
      ['tool-web_search', { query: 'gradient checkpointing' }, 'web_search(gradient checkpointing)'],
      ['tool-find_recent_papers', { topic: 'kv cache' }, 'find_recent_papers(kv cache)'],
      ['tool-course_problems', { k: 5 }, 'course_problems'],
    ];
    for (const [type, input, expected] of cases) {
      const msgs: UIMessage[] = [
        ...turn(1, [{ type, toolCallId: 'x', state: 'output-available', input, output: { anything: true } }]),
        ...turn(2, [{ type: 'text', text: 'ok' }]),
        ...turn(3, [{ type: 'text', text: 'ok' }]),
      ];
      const part = (dietUiMessages(msgs, new Set())[1].parts as any[])[0];
      expect(part.output.note).toBe(expected);
    }
  });

  it('never compacts a non-reading tool result regardless of age', () => {
    const msgs: UIMessage[] = [
      ...turn(1, [{
        type: 'tool-record_evidence', toolCallId: 're1', state: 'output-available',
        input: { slug: 's' }, output: { ok: true },
      }]),
      ...turn(2, [{ type: 'text', text: 'ok' }]),
      ...turn(3, [{ type: 'text', text: 'ok' }]),
    ];
    const out = dietUiMessages(msgs, new Set());
    expect(out[1]).toBe(msgs[1]);
  });
});
