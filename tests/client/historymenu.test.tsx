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
});
