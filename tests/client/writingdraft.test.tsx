// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
// WritingDraftInner now offers a revise round via the thread runtime — same seam the panel
// tests mock (tests/client/libraryPanel.test.tsx).
vi.mock('@assistant-ui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return { ...actual, useThreadRuntime: () => ({ append: appendSpy }) };
});
const appendSpy = vi.fn();
import { render, screen, fireEvent } from '@testing-library/react';
import { WritingDraftInner } from '../../src/client/components/blocks/WritingDraft.js';

describe('WritingDraft', () => {
  it('submits the draft', () => {
    const addResult = vi.fn();
    render(<WritingDraftInner args={{ prompt: 'Argue X', round: 1, pageSlug: 'thesis' }} result={undefined} addResult={addResult} />);
    // The draft field carries an accessible name — a screen reader must not hear a blank text area.
    fireEvent.change(screen.getByRole('textbox', { name: /your draft/i }), { target: { value: 'My argument.' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    // mechanicalIssues rides along from the live Harper review (0 here — the WASM never loaded in
    // jsdom, so the debounced lint leaves the count at its initial 0).
    expect(addResult).toHaveBeenCalledExactlyOnceWith({ draft: 'My argument.', mechanicalIssues: 0 });
  });
  it('renders annotations as highlighted spans', () => {
    render(<WritingDraftInner args={{ prompt: 'Argue X', round: 1, pageSlug: 'thesis' }}
      result={{ draft: 'A strong claim here.', grading: { verdict: 'reviewed', detail: '', annotations: {
        annotations: [{ span: 'strong claim', category: 'strong', note: 'good' }], skillGrades: { claim: 'good' } } } }}
      addResult={vi.fn()} />);
    expect(screen.getByText('strong claim').className).toMatch(/ann-strong/);
  });
  it('numbers annotations and lists them as footnotes', () => {
    const { container } = render(<WritingDraftInner args={{ prompt: 'Argue X', round: 1, pageSlug: 'thesis' }}
      result={{ draft: 'A strong claim here, quite verbose indeed.', grading: { verdict: 'reviewed', detail: '', annotations: {
        annotations: [
          { span: 'strong claim', category: 'strong', note: 'good hook' },
          { span: 'quite verbose', category: 'wordy', note: 'tighten' },
        ], skillGrades: { claim: 'good' } } } }}
      addResult={vi.fn()} />);
    const sups = [...container.querySelectorAll('sup.fn-ref')].map((e) => e.textContent);
    expect(sups).toEqual(['1', '2']);
    const notes = [...container.querySelectorAll('.footnotes li')].map((e) => e.textContent);
    expect(notes).toEqual(['strong good hook', 'wordy tighten']);
  });
  it('drops an empty-span annotation instead of anchoring a footnote to nothing', () => {
    const { container } = render(<WritingDraftInner args={{ prompt: 'Argue X', round: 1, pageSlug: 'thesis' }}
      result={{ draft: 'A strong claim here.', grading: { verdict: 'reviewed', detail: '', annotations: {
        annotations: [
          { span: 'strong claim', category: 'strong', note: 'good' },
          { span: '   ', category: 'ghost', note: 'no anchor' }, // whitespace-only span
        ], skillGrades: {} } } }}
      addResult={vi.fn()} />);
    // Only the real annotation gets a footnote; the empty one is skipped, not rendered blank.
    expect([...container.querySelectorAll('sup.fn-ref')].map((e) => e.textContent)).toEqual(['1']);
    expect(container.querySelector('.ann-ghost')).toBeNull();
  });
});

describe('revise round', () => {
  it('a failed criterion offers Revise, which asks the tutor for round+1', () => {
    appendSpy.mockClear();
    render(<WritingDraftInner args={{ prompt: 'Argue X', round: 1, pageSlug: 'thesis', rubric: ['cites a source'] }}
      result={{ draft: 'draft text', grading: { verdict: 'reviewed', detail: '', rubric: [
        { criterion: 'cites a source', pass: false, note: 'no source' }] } }}
      addResult={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /revise this draft/i }));
    expect(appendSpy).toHaveBeenCalledOnce();
    expect(String(appendSpy.mock.calls[0][0])).toContain('round 2');
  });

  it('carries every criterion verbatim, because "same rubric" alone did not hold', () => {
    // A live revision round graded against a REWRITTEN rubric: round 1's "Correctly identifies that
    // a name beginning with two underscores…" came back as "States the triggering syntax and the
    // dunder exception accurately". The model was asked for the "same rubric" and had to recall it
    // from several turns back. Now the criteria travel in the message.
    appendSpy.mockClear();
    const rubric = ['cites a primary source', 'addresses one counterargument'];
    render(<WritingDraftInner args={{ prompt: 'Argue X', round: 1, pageSlug: 'thesis', rubric }}
      result={{ draft: 'draft text', grading: { verdict: 'reviewed', detail: '', rubric: [
        { criterion: rubric[0], pass: false, note: 'none cited' },
        { criterion: rubric[1], pass: true, note: '' }] } }}
      addResult={vi.fn()} />);
    // This file does not clean up between renders, so earlier cards are still mounted — click the
    // one this test just rendered.
    const buttons = screen.getAllByRole('button', { name: /revise this draft/i });
    fireEvent.click(buttons[buttons.length - 1]);
    const msg = String(appendSpy.mock.calls[0][0]);
    for (const r of rubric) expect(msg).toContain(r); // both, including the one that PASSED
    expect(msg).toMatch(/word for word/i);
  });

  it('a full pass offers no revise button', () => {
    const { container } = render(<WritingDraftInner args={{ prompt: 'Argue X', round: 1, pageSlug: 'thesis', rubric: ['cites a source'] }}
      result={{ draft: 'draft text', grading: { verdict: 'reviewed', detail: '', rubric: [
        { criterion: 'cites a source', pass: true, note: 'good' }] } }}
      addResult={vi.fn()} />);
    // Scoped to this render's container — the suite has no global cleanup, so screen-wide
    // queries would see the previous test's still-mounted card.
    expect(container.querySelector('.revise-btn')).toBeNull();
  });
});

describe('criterion-to-span links', () => {
  const gradedWithQuote = {
    draft: 'The printing press mattered because literacy spread fast.',
    grading: { verdict: 'reviewed', detail: '', rubric: [
      { criterion: 'cites a consequence', pass: true, note: 'yes — "literacy spread fast" is concrete' }] },
  };

  it('a rubric note quoting the draft becomes a toggleable highlight', () => {
    const { container } = render(<WritingDraftInner args={{ prompt: 'Argue', round: 1, pageSlug: 't', rubric: ['cites a consequence'] }}
      result={gradedWithQuote} addResult={vi.fn()} />);
    const link = container.querySelector('.cite-link') as HTMLButtonElement;
    expect(link).toBeTruthy();
    expect(container.querySelector('.ann-cite')).toBeNull();
    fireEvent.click(link);
    expect(container.querySelector('.ann-cite')?.textContent).toBe('literacy spread fast');
    fireEvent.click(link);
    expect(container.querySelector('.ann-cite')).toBeNull();
  });

  it('a quote NOT found in the draft stays plain text — no dead link', () => {
    const { container } = render(<WritingDraftInner args={{ prompt: 'Argue', round: 1, pageSlug: 't', rubric: ['x'] }}
      result={{ draft: 'other words entirely', grading: { verdict: 'reviewed', detail: '', rubric: [
        { criterion: 'x', pass: false, note: 'missing "a phrase that is not there"' }] } }} addResult={vi.fn()} />);
    expect(container.querySelector('.cite-link')).toBeNull();
  });
});
