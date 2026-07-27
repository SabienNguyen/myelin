// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MathScratchpad, MathScratchpadInner } from '../../src/client/components/blocks/MathScratchpad.js';

// Inject a plain-text stub for the MathLive field (jsdom can't run the web component).
const TextInput = ({ onChange, value }: any) => (
  <input aria-label="math-input" value={value} onChange={(e) => onChange(e.target.value)} />
);

const args = { problemLatex: 'x^2', stepMode: true, expectedLatex: '2x', variable: 'x', pageSlug: 'derivatives' };
const type = (v: string) => fireEvent.change(screen.getByLabelText('math-input'), { target: { value: v } });

describe('MathScratchpad', () => {
  afterEach(cleanup);

  it('step mode: adds steps then submits steps + final', () => {
    const addResult = vi.fn();
    render(<MathScratchpadInner args={args} addResult={addResult} MathInput={TextInput} />);
    type('2x');
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(addResult).toHaveBeenCalledExactlyOnceWith({ steps: [{ latex: '2x' }], finalLatex: '2x' });
  });

  it('removes a step', () => {
    const addResult = vi.fn();
    render(<MathScratchpadInner args={args} addResult={addResult} MathInput={TextInput} />);
    type('x^9');
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));
    type('2x');
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));
    fireEvent.click(screen.getByRole('button', { name: 'remove step 1' }));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(addResult).toHaveBeenCalledExactlyOnceWith({ steps: [{ latex: '2x' }], finalLatex: '2x' });
  });

  it('edit recalls a step into the field and save returns it to its own slot', () => {
    const addResult = vi.fn();
    render(<MathScratchpadInner args={args} addResult={addResult} MathInput={TextInput} />);
    type('xx');
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));
    type('2x');
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));
    fireEvent.click(screen.getByRole('button', { name: 'edit step 1' }));
    expect((screen.getByLabelText('math-input') as HTMLInputElement).value).toBe('xx');
    type('3x');
    fireEvent.click(screen.getByRole('button', { name: /save step 1/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    // Slot order preserved: the edited first step stays first, the final stays the last step.
    expect(addResult).toHaveBeenCalledExactlyOnceWith({
      steps: [{ latex: '3x' }, { latex: '2x' }], finalLatex: '2x',
    });
  });

  it('editing a step does not drop an unsaved line in the field', () => {
    const addResult = vi.fn();
    render(<MathScratchpadInner args={args} addResult={addResult} MathInput={TextInput} />);
    type('xx');
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));
    type('2x'); // unsaved — the learner clicks edit without pressing Add step
    fireEvent.click(screen.getByRole('button', { name: 'edit step 1' }));
    fireEvent.click(screen.getByRole('button', { name: /save step 1/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(addResult).toHaveBeenCalledExactlyOnceWith({
      steps: [{ latex: 'xx' }, { latex: '2x' }], finalLatex: '2x',
    });
  });

  it('done card lists the intermediate steps but not the final twice', () => {
    const { container } = render(<MathScratchpad args={args} addResult={vi.fn()}
      result={{ steps: [{ latex: 'x^9' }, { latex: '2x' }], finalLatex: '2x',
        grading: { verdict: 'correct', detail: 'final answer numerically equivalent' } }} />);
    const items = container.querySelectorAll('.scratch-steps li');
    expect(items.length).toBe(1); // the final rides on the "You:" line, not the list
  });
});
