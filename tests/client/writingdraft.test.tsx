// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
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
