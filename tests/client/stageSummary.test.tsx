// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import type { UIMessage } from '../../src/shared/uiMessages.js';
import { StageSummary } from '../../src/client/components/StageSummary.js';

vi.mock('../../src/client/components/BlockProse.js', () => ({
  BlockProse: ({ text }: { text: string }) => <span>{text}</span>,
}));
afterEach(cleanup);
const answered: UIMessage[] = [{ id: 'a1', role: 'assistant', parts: [{
  type: 'tool-structured_check', toolCallId: 'check-1', state: 'output-available',
  input: { prompt: 'Find the throughput', checker: { kind: 'vector', expected: [125] } },
  output: { values: ['125'], grading: { verdict: 'correct', detail: 'Correct throughput.' } },
}] }];

describe('Stage continuity', () => {
  it('retains the math problem, derivation and final answer as rendered math', () => {
    const { container } = render(<StageSummary messages={[{ id: 'math', role: 'assistant', parts: [{
      type: 'tool-math_scratchpad', toolCallId: 'math-1', state: 'output-available',
      input: { problemLatex: 'x^2', stepMode: true },
      output: { steps: [{ latex: 'x+x' }, { latex: '2x' }], finalLatex: '2x',
        grading: { verdict: 'correct', detail: 'Derivative is correct.' } },
    }] }]} />);
    expect(screen.getByText('Your work')).toBeTruthy();
    expect(screen.getByText('Final answer')).toBeTruthy();
    expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole('status').textContent).toContain('Derivative is correct.');
  });
  it('offers explicit retry for failed grading and disables it while running', () => {
    const messages = structuredClone(answered);
    (messages[0].parts[0] as any).output.grading = { verdict: 'ungraded', retryable: true, detail: 'Provider unavailable.' };
    const retry = vi.fn();
    const { rerender } = render(<StageSummary messages={messages} onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry grading' }));
    expect(retry).toHaveBeenCalledWith('check-1');
    rerender(<StageSummary messages={messages} onRetry={retry} isRunning />);
    expect((screen.getByRole('button', { name: 'Retry grading' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('keeps the latest submitted exercise and verdict visible after a text-only turn', () => {
    render(<StageSummary messages={[...answered, { id: 'a2', role: 'assistant', parts: [
      { type: 'text', text: 'Ready for the next topic?' },
    ] }]} />);
    expect(screen.getByText('Find the throughput')).toBeTruthy();
    expect(screen.getByText(/125/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Correct throughput.');
  });
  it('yields to an unanswered exercise and clears when the conversation changes', () => {
    const { rerender } = render(<StageSummary messages={answered} />);
    rerender(<StageSummary messages={[...answered, { id: 'a2', role: 'assistant', parts: [{
      type: 'tool-quiz', toolCallId: 'quiz-2', state: 'input-available', input: {},
    }] }]} />);
    expect(screen.queryByText('Find the throughput')).toBeNull();
    rerender(<StageSummary messages={[]} />);
    expect(screen.queryByRole('region')).toBeNull();
  });
  it('does not label an ungraded answer as graded', () => {
    const messages = structuredClone(answered);
    (messages[0].parts[0] as any).output.grading = { verdict: 'ungraded', detail: 'Could not parse this format.' };
    render(<StageSummary messages={messages} />);
    expect(screen.getByText('not graded')).toBeTruthy();
    expect(screen.queryByText('graded')).toBeNull();
    expect(screen.getByText(/125/)).toBeTruthy();
  });
});
