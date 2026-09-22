// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Verdict } from '../../src/client/components/blocks/Verdict.js';

afterEach(() => { cleanup(); });

const line = () => screen.getByRole('status').textContent ?? '';

describe('Verdict provenance', () => {
  // Only the exception is named — Quiz.tsx's stated convention for its per-item chip, applied at
  // block level so the card and the rows beneath it cannot contradict each other.
  it('a machine check and a model opinion do not read alike', () => {
    const { unmount } = render(<Verdict grading={{ verdict: 'correct', detail: '3/3', source: 'mechanical' }} />);
    const machine = line();
    unmount();
    render(<Verdict grading={{ verdict: 'correct', detail: '3/3', source: 'model' }} />);
    expect(machine).not.toBe(line());
    expect(machine).toBe('3/3');
    expect(line()).toContain('judged by the tutor');
  });

  it('says nothing about provenance when the grader itself failed', () => {
    // session.ts stamps source 'model' on a grader that threw — "judged by the tutor" there would
    // credit a judgement nobody made.
    render(<Verdict grading={{ verdict: 'ungraded', detail: 'Could not grade this answer', source: 'model' }} />);
    expect(line()).not.toContain('judged');
    expect(line()).toBe('Could not grade this answer');
  });

  it('stays silent on a turn saved before the field existed', () => {
    render(<Verdict grading={{ verdict: 'correct', detail: '3/3' }} />);
    expect(line()).toBe('3/3');
  });

  it('keeps the qualifier out of the verdict colour, so it reads as how, not as praise', () => {
    render(<Verdict grading={{ verdict: 'correct', detail: '3/3', source: 'model' }} />);
    const qualifier = screen.getByRole('status').querySelector('.verdict-source');
    expect(qualifier).toBeTruthy();
    expect(qualifier!.className).toBe('verdict-source');
  });

  it('the word form carries provenance too — quick_check shows no detail to carry it otherwise', () => {
    render(<Verdict grading={{ verdict: 'correct', detail: '', source: 'model' }} dash word />);
    expect(line()).toBe(' — correct · judged by the tutor');
  });
});
