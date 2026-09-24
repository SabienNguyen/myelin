// @vitest-environment jsdom
// Choices carry maths as often as the question does, and a ✗ with no right answer beside it leaves
// the learner guessing what they missed. These pin both, on the quick check and the quiz.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QuickCheck } from '../../src/client/components/blocks/QuickCheck.js';
import { Quiz, QuizInner } from '../../src/client/components/blocks/Quiz.js';

afterEach(cleanup);

const qc = { question: 'What is $\\frac{1}{2} + \\frac{1}{2}$?', mode: 'choice', choices: ['$1$', '$\\frac{1}{4}$'], expected: '$1$', pageSlug: 'fractions' };

describe('maths in choices', () => {
  it('a quick check renders its choices as maths, not LaTeX source, and still submits the raw choice', () => {
    const addResult = vi.fn();
    const { container } = render(<QuickCheck args={qc} result={undefined} addResult={addResult} />);
    // KaTeX keeps the TeX source in a hidden MathML annotation, so the delimiters are the tell.
    expect(container.textContent).not.toContain('$\\frac{1}{4}$');
    expect(container.querySelectorAll('button .katex').length).toBeGreaterThanOrEqual(2);
    const buttons = [...container.querySelectorAll('button')].filter((b) => b.querySelector('.katex'));
    fireEvent.click(buttons[1]);
    expect(addResult.mock.calls[0][0].answer).toBe('$\\frac{1}{4}$');
  });

  it('a quiz renders its choices as maths', () => {
    const args = { title: 'T', items: [{ id: 'q1', type: 'choice', prompt: 'p', choices: ['$x^2$', '$2x$'], pageSlug: 'd' }] };
    const { container } = render(<QuizInner args={args} addResult={vi.fn()} />);
    expect(container.textContent).not.toContain('$x^2$');
    expect(container.querySelectorAll('button .katex').length).toBe(2);
  });
});

describe('the right answer beside a miss', () => {
  it('a wrong quick check shows the expected answer; a right one does not', () => {
    const wrong = { answer: '$\\frac{1}{4}$', grading: { verdict: 'incorrect', detail: 'no', source: 'mechanical' } };
    const { container, rerender } = render(<QuickCheck args={qc} result={wrong} addResult={vi.fn()} />);
    expect(screen.getByText(/Answer:/)).toBeTruthy();
    expect(container.querySelector('.quiz-expected .katex')).toBeTruthy();
    rerender(<QuickCheck args={qc} result={{ answer: '$1$', grading: { verdict: 'correct', detail: 'yes' } }} addResult={vi.fn()} />);
    expect(screen.queryByText(/Answer:/)).toBeNull();
  });

  it('names a model-graded key as the tutor\'s, and shows it with the grader\'s reason on a partial', () => {
    const partial = { answer: 'increasing', grading: { verdict: 'partial', detail: 'monotone, but not strictly', source: 'model' } };
    render(<QuickCheck args={{ question: 'q?', expected: 'non-decreasing' }} result={partial} addResult={vi.fn()} />);
    expect(screen.queryByText(/^Answer:/)).toBeNull();
    expect(screen.getByText(/Tutor's answer: non-decreasing/)).toBeTruthy();
    expect(screen.getByText('monotone, but not strictly')).toBeTruthy();
  });

  it('shows an answer key literally, typesetting only its delimited maths', () => {
    const wrong = { answer: 'xyz', grading: { verdict: 'incorrect', detail: 'no', source: 'mechanical' } };
    const { container } = render(<QuickCheck args={{ question: 'q?', expected: '__init__ or x*y*z at $x^2$' }} result={wrong} addResult={vi.fn()} />);
    const line = container.querySelector('p.quiz-expected')!;
    expect(line.querySelector('strong, em')).toBeNull();
    expect(line.textContent).toContain('__init__ or x*y*z at ');
    expect(line.querySelector('.katex')).toBeTruthy();
  });

  it('a quiz names the answer only on the items it marked wrong, and only when it has one', () => {
    const args = { title: 'T', items: [
      { id: 'q1', type: 'short', prompt: 'Differentiate x^3', expected: '3x^2', pageSlug: 'd' },
      { id: 'q2', type: 'short', prompt: 'Open question', pageSlug: 'd' },
      { id: 'q3', type: 'short', prompt: 'Say limit', expected: 'limit', pageSlug: 'd' },
    ] };
    const result = {
      answers: [{ id: 'q1', answer: '3x' }, { id: 'q2', answer: 'something' }, { id: 'q3', answer: 'limit' }],
      grading: { verdict: 'partial', detail: '1 of 3', perItem: [
        { id: 'q1', correct: false }, { id: 'q2', correct: false, source: 'model' }, { id: 'q3', correct: true },
      ] },
    };
    const { container } = render(<Quiz args={args} result={result} addResult={vi.fn()} />);
    const shown = [...container.querySelectorAll('.quiz-expected')].map((e) => e.textContent);
    expect(shown).toEqual([' · answer: 3x^2']);
  });
});
