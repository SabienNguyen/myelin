// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import { HistoryMenu } from '../../src/client/components/HistoryMenu.js';
import { panelBus } from '../../src/client/lib/panelBus.js';

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

const threads = [
  { id: 'default', title: 'Fractions review', updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), messages: 4 },
  { id: 't-abc', title: 'Derivatives intro', updatedAt: new Date().toISOString(), messages: 2, notebook: { id: 'nb-1', title: 'Calculus I' } },
];

describe('HistoryMenu', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(threads)));
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
    // A filed conversation names its notebook; a loose one does not.
    expect(screen.getByRole('menuitem', { name: /^Derivatives intro/ }).textContent).toContain('Calculus I');
    expect(screen.getByRole('menuitem', { name: /^Fractions review/ }).textContent).not.toContain('Calculus I');
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

  it('keeps the fresh list when a request from an earlier opening lands late', async () => {
    let releaseFirst!: () => void;
    (fetch as any).mockReset()
      .mockImplementationOnce(() => new Promise((r) => { releaseFirst = () => r(reply([{ ...threads[0], title: 'stale list' }])); }))
      .mockResolvedValue(reply(threads));
    render(<HistoryMenu activeId="default" onSelect={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /conversation history/i });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(await screen.findByText('Fractions review')).toBeTruthy();
    await act(async () => { releaseFirst(); });
    expect(screen.queryByText('stale list')).toBeNull();
  });

  it('says so when the list cannot load', async () => {
    (fetch as any).mockResolvedValue(reply({}, 500));
    render(<HistoryMenu activeId="default" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /conversation history/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn’t load your conversations/);
  });

  it('lists fifty conversations and hands the rest to the palette search', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `t-${i}`, title: `conversation ${i}`, updatedAt: new Date().toISOString(), messages: 2 }));
    (fetch as any).mockResolvedValue(reply(many));
    const opened: string[] = [];
    const off = panelBus.subscribe((e) => { opened.push(e.type); });
    render(<HistoryMenu activeId="default" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /conversation history/i }));
    await screen.findByText('conversation 49');
    expect(screen.queryByText('conversation 50')).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'search all 60 conversations' }));
    off();
    expect(opened).toEqual(['openPalette']);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('deletes a conversation only after the confirmation, and leaves an open one for a new one', async () => {
    const onSelect = vi.fn();
    render(<HistoryMenu activeId="default" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /conversation history/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete “Derivatives intro”' }));
    expect((fetch as any).mock.calls.some(([, init]: any[]) => init?.method === 'DELETE')).toBe(false);
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Derivatives intro')).toBeTruthy();

    (fetch as any).mockResolvedValue(reply(null, 204));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete “Derivatives intro”' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete conversation' }));
    await waitFor(() => expect(screen.queryByText('Derivatives intro')).toBeNull());
    expect(fetch).toHaveBeenCalledWith('/api/thread/t-abc', expect.objectContaining({ method: 'DELETE' }));
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete “Fractions review”' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete conversation' }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect.mock.calls[0][0]).toMatch(/^t-/);
  });
});
