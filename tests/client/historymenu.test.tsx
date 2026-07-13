// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { HistoryMenu } from '../../src/client/components/HistoryMenu.js';

const threads = [
  { id: 'default', title: 'Fractions review', updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), messages: 4 },
  { id: 't-abc', title: 'Derivatives intro', updatedAt: new Date().toISOString(), messages: 2 },
];

describe('HistoryMenu', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => threads }));
  });
  afterEach(() => {
    cleanup(); // this suite renders the same "Conversation history" button in every test;
    // the repo doesn't set vitest `globals: true`, so @testing-library/react's own
    // typeof-afterEach auto-cleanup never registers — must clean up explicitly.
    vi.unstubAllGlobals();
  });

  it('opens the panel and renders thread rows fetched from /api/threads', async () => {
    render(<HistoryMenu activeId="default" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /conversation history/i }));
    expect(await screen.findByText('Fractions review')).toBeTruthy();
    expect(screen.getByText('Derivatives intro')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/api/threads');
  });

  it('clicking a row calls onSelect with that thread id and closes the panel', async () => {
    const onSelect = vi.fn();
    render(<HistoryMenu activeId="default" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /conversation history/i }));
    fireEvent.click(await screen.findByText('Derivatives intro'));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('t-abc');
    expect(screen.queryByText('Fractions review')).toBeNull();
  });

  it('"New conversation" fires onSelect with a fresh non-default id and closes the panel', async () => {
    const onSelect = vi.fn();
    render(<HistoryMenu activeId="default" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /conversation history/i }));
    fireEvent.click(await screen.findByText(/new conversation/i));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const newId = onSelect.mock.calls[0][0];
    expect(newId).not.toBe('default');
    expect(newId).toMatch(/^t-/);
    expect(screen.queryByText('Fractions review')).toBeNull();
  });

  it('highlights the active thread row', async () => {
    render(<HistoryMenu activeId="default" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /conversation history/i }));
    const activeRow = (await screen.findByText('Fractions review')).closest('button');
    expect(activeRow?.className).toContain('active');
    const otherRow = screen.getByText('Derivatives intro').closest('button');
    expect(otherRow?.className).not.toContain('active');
  });

  it('closes the panel on Escape', async () => {
    render(<HistoryMenu activeId="default" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /conversation history/i }));
    await screen.findByText('Fractions review');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Fractions review')).toBeNull();
  });

  it('closes the panel on an outside click', async () => {
    render(
      <div>
        <div data-testid="outside">outside</div>
        <HistoryMenu activeId="default" onSelect={vi.fn()} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /conversation history/i }));
    await screen.findByText('Fractions review');
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByText('Fractions review')).toBeNull();
  });

  it('exposes aria-haspopup and reflects open state via aria-expanded on the trigger', () => {
    render(<HistoryMenu activeId="default" onSelect={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /conversation history/i });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('moves focus to the first menuitem when the panel opens', () => {
    render(<HistoryMenu activeId="default" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /conversation history/i }));
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
  });

  it('moves roving focus through menuitems with ArrowDown/ArrowUp', async () => {
    render(<HistoryMenu activeId="default" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /conversation history/i }));
    await screen.findByText('Fractions review');
    const items = screen.getAllByRole('menuitem');
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[1]);
  });

  it('wraps focus from the last menuitem to the first on ArrowDown', async () => {
    render(<HistoryMenu activeId="default" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /conversation history/i }));
    await screen.findByText('Derivatives intro');
    const items = screen.getAllByRole('menuitem');
    fireEvent.keyDown(document, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('wraps focus from the first menuitem to the last on ArrowUp', async () => {
    render(<HistoryMenu activeId="default" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /conversation history/i }));
    await screen.findByText('Derivatives intro');
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('closes the panel on Escape and returns focus to the trigger button', async () => {
    render(<HistoryMenu activeId="default" onSelect={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /conversation history/i });
    fireEvent.click(trigger);
    await screen.findByText('Fractions review');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Fractions review')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
