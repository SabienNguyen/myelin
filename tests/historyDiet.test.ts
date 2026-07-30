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
    expect(oldPart.input).toEqual({ compacted: true, prompt: 'What is a derivative?' });
    expect(oldPart.output).toEqual({ compacted: true, answer: 'slope', verdict: 'correct', detail: 'exact match' });
    expect(freshPart.input.choices).toEqual(['slope', 'area']);
    expect(freshPart.output.grading.verdict).toBe('correct');
  });

  it('caps long payloads — a code submission compacts to its first 160 chars', () => {
    const code = 'def f(x):\n    return x * 2\n'.repeat(40);
    const msgs = asMessages([{
      type: 'tool-code_exercise', toolCallId: 'c1', state: 'output-available',
      input: { prompt: 'Double it', starter: code },
      output: { code, grading: { verdict: 'correct', source: 'mechanical', detail: 'tests passed' } },
    }]);
    const part = (dietUiMessages(msgs, new Set())[1].parts as any[])[0];
    expect(part.output.answer.length).toBeLessThanOrEqual(161); // cap + ellipsis
    expect(part.output.answer.endsWith('…')).toBe(true);
    expect(JSON.stringify(part).length).toBeLessThan(600);
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

  it('is deterministic: the same history compacts identically on every call', () => {
    const msgs = asMessages([gradedBlock('old')]);
    const a = JSON.stringify(dietUiMessages(msgs, new Set()));
    const b = JSON.stringify(dietUiMessages(msgs, new Set()));
    expect(a).toBe(b);
  });
});
