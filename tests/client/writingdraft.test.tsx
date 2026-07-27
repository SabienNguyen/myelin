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
