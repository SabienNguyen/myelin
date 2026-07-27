// @vitest-environment jsdom
// Display form of structured_check answers — the other half of the BlockProse fix. The prompt
// could render H₂O while the learner's own answer sat beside it as `H2O`; these pin the transform
// that closes that gap, and the property that matters more than any rendering: grading never sees it.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { prettyAnswer } from '../../src/client/lib/answerDisplay.js';
import { StructuredCheck } from '../../src/client/components/blocks/StructuredCheck.js';

describe('prettyAnswer', () => {
  it('subscripts digits that follow a letter or closing paren', () => {
    expect(prettyAnswer('H2O')).toBe('H₂O');
    expect(prettyAnswer('C6H12O6')).toBe('C₆H₁₂O₆');
    expect(prettyAnswer('Ca(OH)2')).toBe('Ca(OH)₂');
  });

  it('leaves a stoichiometric coefficient full-size — it is not a subscript', () => {
    expect(prettyAnswer('2H2O')).toBe('2H₂O');
  });

  it('superscripts after a caret, signs included', () => {
    expect(prettyAnswer('SO4^2-')).toBe('SO₄²⁻');
    expect(prettyAnswer('x^2')).toBe('x²');
  });

  it('renders a typed equation with a real reaction arrow', () => {
    expect(prettyAnswer('CH4 + 2O2 -> CO2 + 2H2O')).toBe('CH₄ + 2O₂ → CO₂ + 2H₂O');
    // The arrow rule needs its delimiting spaces — a cramped -> is a parse error the checker
    // explains, not something display should paper over.
    expect(prettyAnswer('a->b')).toBeNull();
  });

  it('returns null when nothing would change, so plain answers get no echo', () => {
    for (const plain of ['42', 'mitochondria', 'route 66', '', 'F, Cl, Br']) {
      expect(prettyAnswer(plain)).toBeNull();
    }
  });

  it('keeps its hands off LaTeX — that is BlockProse territory', () => {
    expect(prettyAnswer('$x_1^2$')).toBeNull();
  });
});

describe('StructuredCheck answer preview', () => {
  afterEach(cleanup);
  const args = (checker: any) => ({ prompt: 'q', pageSlug: 'p', checker });

  it('appears as the learner types a formula, and reads as the formula', () => {
    render(<StructuredCheck args={args({ kind: 'pattern', expected: 'H2O' })} result={null} addResult={() => {}} />);
    const input = screen.getByLabelText('answer');
    expect(document.querySelector('.structured-preview')).toBeNull(); // nothing typed, no echo
    fireEvent.change(input, { target: { value: 'H2O' } });
    expect(document.querySelector('.structured-preview')?.textContent).toContain('H₂O');
  });

  it('never appears for an answer that renders as itself', () => {
    render(<StructuredCheck args={args({ kind: 'numeric', expected: 42 })} result={null} addResult={() => {}} />);
    fireEvent.change(screen.getByLabelText('numeric answer'), { target: { value: '42' } });
    expect(document.querySelector('.structured-preview')).toBeNull();
  });

  it('submits the RAW string — the preview must never reach grading', () => {
    let submitted: any;
    render(<StructuredCheck
      args={args({ kind: 'pattern', expected: 'H2O' })} result={null}
      addResult={(r: any) => { submitted = r; }}
    />);
    fireEvent.change(screen.getByLabelText('answer'), { target: { value: 'H2O' } });
    fireEvent.click(screen.getByText('Submit'));
    expect(submitted.values).toEqual(['H2O']); // not H₂O
  });

  it('previews a set answer once any line differs, without revealing the expected count', () => {
    render(<StructuredCheck
      args={args({ kind: 'set', expected: ['H2O', 'CO2'] })} result={null} addResult={() => {}}
    />);
    const box = screen.getByLabelText('one per line, in any order');
    fireEvent.change(box, { target: { value: 'water' } });
    expect(document.querySelector('.structured-preview')).toBeNull();
    fireEvent.change(box, { target: { value: 'H2O\nCO2' } });
    expect(document.querySelector('.structured-preview')?.textContent).toContain('H₂O · CO₂');
  });

  it('renders a chem_equation prompt as chemistry, not ASCII', () => {
    // The tutor writes formulas in typed form; the learner should still read printed chemistry —
    // otherwise the question looks less like chemistry than the answer preview under it.
    render(<StructuredCheck
      args={{ prompt: 'Balance: CH4 + O2 -> CO2 + H2O', pageSlug: 'p',
        checker: { kind: 'chem_equation', reactants: ['CH4', 'O2'], products: ['CO2', 'H2O'] } }}
      result={null} addResult={() => {}}
    />);
    expect(document.querySelector('.structured-prompt')?.textContent).toContain('CH₄ + O₂ → CO₂ + H₂O');
  });

  it('shows the numeric unit suffix in printed form', () => {
    render(<StructuredCheck
      args={args({ kind: 'numeric', expected: 9.8, unit: 'm/s^2' })} result={null} addResult={() => {}}
    />);
    expect(document.querySelector('.structured-unit')?.textContent).toBe('m/s²');
  });

  it('shows the pretty form on the graded card too', () => {
    render(<StructuredCheck
      args={args({ kind: 'pattern', expected: 'H2O' })}
      result={{ values: ['H2O'], grading: { verdict: 'correct', detail: 'ok' } }}
      addResult={() => {}}
    />);
    expect(document.querySelector('.structured-answer')?.textContent).toContain('H₂O');
  });
});
