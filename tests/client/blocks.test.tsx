// @vitest-environment jsdom
// A tool call the server REJECTS (zod refuses the model's input) still renders through the
// block's done-branch, with an output that is NOT the result contract — an error object.
// One unguarded property read there unmounted the whole React root: a malformed quiz blanked
// the entire app in audit 27. These tests pin that every block with a done-branch survives an
// error-shaped result and still renders SOMETHING (the app must outlive the model's mistake).
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Quiz } from '../../src/client/components/blocks/Quiz.js';
import { StructuredCheck } from '../../src/client/components/blocks/StructuredCheck.js';
import { WritingDraftInner } from '../../src/client/components/blocks/WritingDraft.js';

// What the client actually receives for a rejected call: not {answers}, not {values}, not {draft}.
const errorResult = { error: 'Invalid input: expected string, received undefined' };

describe('blocks survive a server-rejected (non-contract) result', () => {
  it('Quiz renders its items instead of crashing on result.answers', () => {
    render(<Quiz
      args={{ title: 'Stream parsing check', items: [
        { id: 'q1', type: 'choice', prompt: 'Which survives across reads?', choices: ['a', 'b'], pageSlug: 's' },
      ] }}
      result={errorResult}
      addResult={vi.fn()}
    />);
    expect(screen.getByText('Stream parsing check')).toBeTruthy();
    expect(screen.getByText(/which survives across reads/i)).toBeTruthy();
  });

  it('StructuredCheck renders the prompt and a blank answer on missing result.values', () => {
    render(<StructuredCheck
      args={{ prompt: 'How many?', pageSlug: 's', checker: { kind: 'numeric', expected: 3 } }}
      result={errorResult}
      addResult={vi.fn()}
    />);
    expect(screen.getByText(/how many/i)).toBeTruthy();
    expect(screen.getByText(/\(blank\)/)).toBeTruthy();
  });

  it('WritingDraft renders the prompt on missing result.draft', () => {
    render(<WritingDraftInner
      args={{ prompt: 'Argue X', round: 1, pageSlug: 'thesis' }}
      result={errorResult}
      addResult={vi.fn()}
    />);
    expect(screen.getByText(/argue x/i)).toBeTruthy();
  });
});
