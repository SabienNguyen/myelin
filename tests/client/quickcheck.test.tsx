// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
