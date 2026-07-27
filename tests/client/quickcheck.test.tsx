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
