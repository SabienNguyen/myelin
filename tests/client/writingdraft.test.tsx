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
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My argument.' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(addResult).toHaveBeenCalledExactlyOnceWith({ draft: 'My argument.' });
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
