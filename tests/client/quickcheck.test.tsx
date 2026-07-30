// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QuickCheck } from '../../src/client/components/blocks/QuickCheck.js';

describe('QuickCheck', () => {
  it('choice mode: click submits the answer once', () => {
    const addResult = vi.fn();
    render(<QuickCheck args={{ question: '2+2?', mode: 'choice', choices: ['3', '4'], pageSlug: 'arith' }}
      result={undefined} addResult={addResult} />);
    fireEvent.click(screen.getByRole('button', { name: '4' }));
    expect(addResult).toHaveBeenCalledExactlyOnceWith({ answer: '4' });
  });
  it('renders grading verdict once result exists', () => {
    render(<QuickCheck args={{ question: '2+2?', mode: 'choice', choices: ['3', '4'], pageSlug: 'arith' }}
      result={{ answer: '4', grading: { verdict: 'correct', detail: 'exact match' } }} addResult={vi.fn()} />);
    expect(screen.getByText(/correct/i)).toBeTruthy();
  });
});

describe('QuickCheck submitted/graded tag', () => {
  afterEach(cleanup);

  // In a multi-block turn grading waits for the LAST block, so this card sits answered-but-
  // ungraded for a while; the tag is what tells the learner that state is expected.
  it('says submitted before grading arrives', () => {
    render(<QuickCheck args={{ question: 'q?' }} result={{ answer: 'power rule' }} addResult={vi.fn()} />);
    expect(screen.getByText('submitted')).toBeTruthy();
  });
  it('says graded once grading exists', () => {
    render(<QuickCheck args={{ question: 'q?' }}
      result={{ answer: 'power rule', grading: { verdict: 'correct', detail: 'exact match' } }} addResult={vi.fn()} />);
    expect(screen.getByText(/graded/)).toBeTruthy();
  });
});

describe('QuickCheck verdict live region', () => {
  afterEach(cleanup);

  // aria-live announces CHANGES: the status element must exist from submit time and gain its
  // text when grading lands. A region that mounts already holding the verdict says nothing.
  it('mounts the status region empty at submit and fills the SAME element on grading', () => {
    const args = { question: 'q?' };
    const { rerender } = render(<QuickCheck args={args} result={{ answer: 'x' }} addResult={vi.fn()} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    rerender(<QuickCheck args={args}
      result={{ answer: 'x', grading: { verdict: 'correct', detail: 'exact match' } }} addResult={vi.fn()} />);
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toContain('correct');
  });
});

// Confidence-before-reveal: an OPTIONAL pre-answer rating. The output must carry `confidence`
// only when the learner actually chose one — the calibration built on it (/api/progress) is only
// honest if every counted rating was deliberate.
describe('QuickCheck confidence toggle', () => {
  afterEach(cleanup);
  const args = { question: '2+2?', mode: 'choice', choices: ['3', '4'], pageSlug: 'arith' };

  it('renders a radiogroup with two unchecked radios', () => {
    render(<QuickCheck args={args} result={undefined} addResult={vi.fn()} />);
    const group = screen.getByRole('radiogroup', { name: 'How confident?' });
    expect(group).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['sure', 'unsure']);
    for (const r of radios) expect(r.getAttribute('aria-checked')).toBe('false');
  });

  it('selecting sure then answering includes confidence in the result', () => {
    const addResult = vi.fn();
    render(<QuickCheck args={args} result={undefined} addResult={addResult} />);
    fireEvent.click(screen.getByRole('radio', { name: 'sure' }));
    expect(screen.getByRole('radio', { name: 'sure' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '4' }));
    expect(addResult).toHaveBeenCalledExactlyOnceWith({ answer: '4', confidence: 'sure' });
  });

  it('answering without selecting sends no confidence key at all', () => {
    const addResult = vi.fn();
    render(<QuickCheck args={args} result={undefined} addResult={addResult} />);
    fireEvent.click(screen.getByRole('button', { name: '4' }));
    expect(addResult).toHaveBeenCalledExactlyOnceWith({ answer: '4' });
    expect(addResult.mock.calls[0][0]).not.toHaveProperty('confidence');
  });

  it('re-clicking the chosen chip clears it — a mis-click must not force a rating', () => {
    const addResult = vi.fn();
    render(<QuickCheck args={args} result={undefined} addResult={addResult} />);
    fireEvent.click(screen.getByRole('radio', { name: 'unsure' }));
    fireEvent.click(screen.getByRole('radio', { name: 'unsure' }));
    fireEvent.click(screen.getByRole('button', { name: '4' }));
    expect(addResult).toHaveBeenCalledExactlyOnceWith({ answer: '4' });
  });

  it('text mode carries the chosen confidence through the input submit', () => {
    const addResult = vi.fn();
    render(<QuickCheck args={{ question: 'q?', pageSlug: 'p' }} result={undefined} addResult={addResult} />);
    fireEvent.click(screen.getByRole('radio', { name: 'unsure' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '2x' } });
    fireEvent.submit(input.closest('form')!);
    expect(addResult).toHaveBeenCalledExactlyOnceWith({ answer: '2x', confidence: 'unsure' });
  });

  it('the done card echoes the rating, and stays silent when none was sent', () => {
    const { unmount } = render(<QuickCheck args={args}
      result={{ answer: '4', confidence: 'sure', grading: { verdict: 'correct', detail: 'exact match' } }}
      addResult={vi.fn()} />);
    expect(screen.getByText(/you said sure/)).toBeTruthy();
    unmount();
    render(<QuickCheck args={args}
      result={{ answer: '4', grading: { verdict: 'correct', detail: 'exact match' } }} addResult={vi.fn()} />);
    expect(screen.queryByText(/you said/)).toBeNull();
  });
});

describe('QuickCheck graded card with no answer', () => {
  // Scoped to this block: the tests above predate it and render without cleanup, and unmounting
  // between cases here is what keeps the two blank variants from matching each other's output.
  afterEach(cleanup);

  it('says "(blank)" instead of a dangling "You:"', () => {
    render(<QuickCheck args={{ question: 'q?' }} result={{ answer: '' }} addResult={() => {}} />);
    expect(screen.getByText(/You: \(blank\)/)).toBeTruthy();
  });

  it('treats whitespace-only as blank too', () => {
    render(<QuickCheck args={{ question: 'q?' }} result={{ answer: '   ' }} addResult={() => {}} />);
    // A learner who hit space then Enter is in exactly the same position as one who hit Enter.
    expect(screen.getByText(/You: \(blank\)/)).toBeTruthy();
  });

  it('still shows a real answer verbatim', () => {
    render(<QuickCheck args={{ question: 'q?' }} result={{ answer: '2x' }} addResult={() => {}} />);
    expect(screen.getByText(/You: 2x/)).toBeTruthy();
  });
});
