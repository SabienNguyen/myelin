// @vitest-environment jsdom
// The live grammar/style review under a writing draft. It renders Harper's located lints and
// offers a one-click fix per lint — the presentational contract, tested with plain lint objects so
// the Harper WASM (harperLinter.ts, dynamically imported) never has to load here.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { HarperReview, applyLintToDraft } from '../../src/client/components/blocks/WritingDraft.js';
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

describe('applyLintToDraft — fixes splice only against live offsets', () => {
  it('applies a suggestion whose span still covers the flagged text', () => {
    const draft = 'I have thier book.';
    const l = lint({ start: 7, end: 12, problem: 'thier', suggestion: 'their' });
    expect(applyLintToDraft(draft, l)).toBe('I have their book.');
  });

  it('is a no-op when a lint has no suggestion', () => {
    const draft = 'a passive sentence was written';
    expect(applyLintToDraft(draft, lint({ start: 0, end: 1, problem: 'a', suggestion: undefined }))).toBe(draft);
  });

  it('refuses a STALE lint whose offsets no longer cover its problem text', () => {
    // The rapid-double-fix hazard: fixing an earlier issue shifts every later offset. A second
    // fix applied against the old span would corrupt the draft — the guard rejects it instead.
    const draft = 'I have their book.'; // "thier" already fixed to "their" (+0 here, but positions moved)
    const stale = lint({ start: 7, end: 12, problem: 'thier', suggestion: 'their' }); // slice is now 'their', ≠ 'thier'
    expect(applyLintToDraft(draft, stale)).toBe(draft); // unchanged, not mangled
  });

  it('two fixes in sequence: the first applies, the now-stale second is safely skipped', () => {
    // "I has a apple" with lints [has→have @4-7] and [a→an @8-9]. Fixing "has"→"have" grows the
    // string, so the "a"→"an" lint's absolute span (8-9) no longer points at "a".
    let d = 'I has a apple';
    const l1 = lint({ start: 2, end: 5, problem: 'has', suggestion: 'have' });
    const l2 = lint({ start: 6, end: 7, problem: 'a', suggestion: 'an' });
    d = applyLintToDraft(d, l1);
    expect(d).toBe('I have a apple');
    d = applyLintToDraft(d, l2); // stale: d.slice(6,7) is 'e', not 'a'
    expect(d).toBe('I have a apple'); // not corrupted — waits for the re-lint to refresh offsets
  });
});
