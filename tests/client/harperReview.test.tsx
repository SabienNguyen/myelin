// @vitest-environment jsdom
// The live grammar/style review under a writing draft. It renders Harper's located lints and
// offers a one-click fix per lint — the presentational contract, tested with plain lint objects so
// the Harper WASM (harperLinter.ts, dynamically imported) never has to load here.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { HarperReview } from '../../src/client/components/blocks/WritingDraft.js';
import type { DraftLint } from '../../src/client/lib/harperLinter.js';

afterEach(cleanup);

const lint = (over: Partial<DraftLint>): DraftLint => ({
  start: 0, end: 4, kind: 'Spelling', message: 'Did you mean “their”?', problem: 'thier', ...over,
});

describe('HarperReview', () => {
  it('renders nothing when there are no lints', () => {
    const { container } = render(<HarperReview lints={[]} onApply={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('lists each lint with its kind, message, and offending text, and a headline count', () => {
    render(<HarperReview lints={[lint({ suggestion: 'their' }), lint({ kind: 'Agreement', message: 'subject–verb', problem: 'is' })]} onApply={vi.fn()} />);
    expect(screen.getByText(/2 grammar & style issues/)).toBeTruthy();
    expect(screen.getByText('Spelling')).toBeTruthy();
    expect(screen.getByText('Agreement')).toBeTruthy();
    expect(screen.getByText(/Did you mean/)).toBeTruthy();
  });

  it('a fix button fires onApply with its lint; a lint without a suggestion offers no button', () => {
    const onApply = vi.fn();
    const withFix = lint({ suggestion: 'their' });
    render(<HarperReview lints={[withFix, lint({ problem: 'awkward', suggestion: undefined })]} onApply={onApply} />);
    const buttons = screen.getAllByRole('button', { name: /fix/ });
    expect(buttons).toHaveLength(1); // only the lint that had a suggestion
    fireEvent.click(buttons[0]);
    expect(onApply).toHaveBeenCalledWith(withFix);
  });
});
