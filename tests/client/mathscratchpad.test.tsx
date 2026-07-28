// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Latex, MathScratchpad, MathScratchpadInner } from '../../src/client/components/blocks/MathScratchpad.js';

// Inject a plain-text stub for the MathLive field (jsdom can't run the web component).
const TextInput = ({ onChange, value }: any) => (
  <input aria-label="math-input" value={value} onChange={(e) => onChange(e.target.value)} />
);

const args = { problemLatex: 'x^2', stepMode: true, expectedLatex: '2x', variable: 'x', pageSlug: 'derivatives' };
const type = (v: string) => fireEvent.change(screen.getByLabelText('math-input'), { target: { value: v } });

describe('Latex — mixed prose and math', () => {
  it('renders $-delimited segments as math and the rest as plain text', () => {
    const { container } = render(<Latex tex={'A triangle has base $2\\pi R$ and height $R$.'} />);
    // The prose words stay literal text (not KaTeX variable-soup)...
    expect(container.textContent).toContain('A triangle has base ');
    // ...and the delimited parts really went through KaTeX.
    expect(container.querySelectorAll('.katex').length).toBe(2);
    // No red error spans: nothing was fed to KaTeX that KaTeX cannot parse.
    expect(container.querySelector('.katex-error')).toBeNull();
  });

  it('a pure-LaTeX string still renders whole as before', () => {
    const { container } = render(<Latex tex={'\\frac{d}{dx}x^2'} />);
    expect(container.querySelectorAll('.katex').length).toBe(1);
  });

  it('a non-string never throws (the crash that unmounted the app)', () => {
    expect(() => render(<Latex tex={undefined as any} />)).not.toThrow();
  });

  // A live chain-rule sitting: MathLive turned typed du/dx into its private `\differentialD`
  // macro, and KaTeX painted it as red literal text in the learner's own step list. KaTeX has no
  // katex-error class for an unsupported macro under throwOnError:false — it colors it #cc0000 —
  // so that is what must be absent.
  it("MathLive's private dialect renders as math, not red error text", () => {
    for (const tex of [
      '\\frac{du}{\\differentialD x}',
      '\\exponentialE^{\\imaginaryI\\pi}',
      '\\placeholder{}+2',
      '\\mleft(x+1\\mright)^2',
    ]) {
      const { container } = render(<Latex tex={tex} />);
      expect(container.querySelector('[style*="cc0000"]'), tex).toBeNull();
      cleanup();
    }
  });
});

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

describe('math field accessible name', () => {
  afterEach(cleanup);
  // The injected field forwards the label the way the real MathLiveInput puts it on <math-field>.
  const LabelledInput = ({ onChange, value, label }: any) => (
    <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
  );

  it('names the field after the problem it answers, LaTeX flattened to words', () => {
    render(<MathScratchpadInner
      args={{ ...args, problemLatex: '\\text{Differentiate } f(x) = x^3 - 5x' }}
      addResult={vi.fn()} MathInput={LabelledInput} />);
    expect(screen.getByLabelText('your answer — Differentiate f(x) = x^3 - 5x')).toBeTruthy();
  });

  it('flattens fractions and known commands instead of reading backslashes', () => {
    render(<MathScratchpadInner
      args={{ ...args, problemLatex: '\\frac{x}{2} + \\sqrt{y} \\cdot \\pi' }}
      addResult={vi.fn()} MathInput={LabelledInput} />);
    expect(screen.getByLabelText('your answer — (x)/(2) + sqrt(y) cdot pi')).toBeTruthy();
  });
});
