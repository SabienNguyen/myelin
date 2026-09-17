// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ChangeEvent } from 'react';
import { SymbolInput } from '../../src/client/components/SymbolInput.js';
afterEach(cleanup);
it.each([false, true])('replaces a selection, restores caret and submits Unicode (multiline=%s)', (multiline) => {
  const submit = vi.fn();
  function Harness() {
    const [value, setValue] = useState('L = rate W');
    return <form onSubmit={(e) => { e.preventDefault(); submit(value); }}>
      <SymbolInput multiline={multiline} aria-label="answer" value={value} onChange={(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(e.target.value)} />
      <button>Send</button>
    </form>;
  }
  render(<Harness />);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  input.focus(); input.setSelectionRange(4, 8);
  fireEvent.click(screen.getByRole('button', { name: 'Math symbols' }));
  fireEvent.click(screen.getByRole('button', { name: 'λ — lambda' }));
  expect(input.value).toBe('L = λ W');
  expect(input.selectionStart).toBe(5);
  expect(document.activeElement).toBe(input);
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(submit).toHaveBeenCalledWith('L = λ W');
});
it('supports uncontrolled form fields and repeated insertion', () => {
  render(<form><SymbolInput name="answer" defaultValue="L = " aria-label="answer" /></form>);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  input.setSelectionRange(4, 4);
  fireEvent.click(screen.getByRole('button', { name: 'Math symbols' }));
  fireEvent.click(screen.getByRole('button', { name: 'λ — lambda' }));
  fireEvent.click(screen.getByRole('button', { name: 'μ — mu' }));
  expect(new FormData(input.form!).get('answer')).toBe('L = λμ');
});
