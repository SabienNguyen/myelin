// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { SymbolKeyboard, SYMBOLS } from '../../src/client/components/SymbolKeyboard.js';

afterEach(cleanup);
describe('SymbolKeyboard', () => {
  it('opens on demand and provides named Greek letters and operators', () => {
    render(<SymbolKeyboard onInsert={() => {}} />);
    expect(screen.queryByRole('button', { name: 'λ — lambda' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Math symbols' }));
    for (const name of ['λ — lambda', 'ρ — rho', 'μ — mu', '≤ — less than or equal', '× — multiply', '√ — square root']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(SYMBOLS.every((s) => s.name.length > 0)).toBe(true);
  });
  it('supports keyboard activation without submitting its enclosing form', async () => {
    const insert = vi.fn(); const submit = vi.fn((e) => e.preventDefault());
    render(<form onSubmit={submit}><SymbolKeyboard onInsert={insert} /></form>);
    const user = userEvent.setup();
    await user.tab(); await user.keyboard('{Enter}'); await user.tab();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('λ — lambda');
    await user.keyboard('{ArrowRight}{Enter}');
    expect(insert).toHaveBeenCalledWith('ρ');
    expect(submit).not.toHaveBeenCalled();
  });
});
