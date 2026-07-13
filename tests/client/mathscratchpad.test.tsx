// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MathScratchpadInner } from '../../src/client/components/blocks/MathScratchpad.js';

// Inject a plain-text stub for the MathLive field (jsdom can't run the web component).
const TextInput = ({ onChange, value }: any) => (
  <input aria-label="math-input" value={value} onChange={(e) => onChange(e.target.value)} />
);

describe('MathScratchpad', () => {
  it('step mode: adds steps then submits steps + final', () => {
    const addResult = vi.fn();
    render(<MathScratchpadInner
      args={{ problemLatex: 'x^2', stepMode: true, expectedLatex: '2x', variable: 'x', pageSlug: 'derivatives' }}
      addResult={addResult} MathInput={TextInput} />);
    fireEvent.change(screen.getByLabelText('math-input'), { target: { value: '2x' } });
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(addResult).toHaveBeenCalledExactlyOnceWith({ steps: [{ latex: '2x' }], finalLatex: '2x' });
  });
});
