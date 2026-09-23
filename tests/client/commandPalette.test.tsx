// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { CommandPalette, rankItems, type PaletteItem } from '../../src/client/components/CommandPalette.js';

const item = (kind: PaletteItem['kind'], label: string): PaletteItem =>
  ({ kind, key: `${kind}:${label}`, label, detail: '', href: `#/${label}` });

describe('rankItems', () => {
  const items = [
    item('page', 'Chain rule'), item('page', 'Rule of three'), item('page', 'Limits'),
    item('notebook', 'Calculus I'), item('conversation', 'walk me through the chain rule'),
  ];
  it('puts prefix matches before word matches, and leads with the group holding the best match', () => {
    expect(rankItems(items, 'rule').map((i) => i.label)).toEqual([
      'Rule of three', 'Chain rule', 'walk me through the chain rule',
    ]);
    // "ca" is a prefix of the notebook, so notebooks lead again.
    expect(rankItems(items, 'ca')[0].label).toBe('Calculus I');
  });
  it('matches letters in order with gaps, and drops what does not match at all', () => {
    expect(rankItems(items, 'chrl').map((i) => i.label)).toEqual(['walk me through the chain rule', 'Chain rule']);
    expect(rankItems(items, 'zzz')).toEqual([]);
  });
  it('shows everything, in original order, for an empty query', () => {
    expect(rankItems(items, '').map((i) => i.kind)).toEqual(['notebook', 'conversation', 'page', 'page', 'page']);
  });
  it('ranks an action below a place that matches as well', () => {
    const withAction = [...items, item('action', 'Go to notebooks')];
    expect(rankItems(withAction, 'go')[0].kind).toBe('action'); // only the action starts with "go"
    expect(rankItems([item('notebook', 'Calculus I'), item('action', 'Calculus tools')], 'calc').map((i) => i.kind))
      .toEqual(['notebook', 'action']);
  });
});

describe('CommandPalette', () => {
  beforeEach(() => {
    location.hash = '#/t/t-here';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = url === '/api/notebooks'
        ? { notebooks: [{ id: 'nb-calc', title: 'Calculus I', due: 2, topics: 5 }], unfiled: [] }
        : url === '/api/threads'
          ? [{ id: 't-1', title: 'why is the derivative a limit?', messages: 3, notebook: { id: 'nb-calc', title: 'Calculus I' } }, { id: 't-empty', title: 't-empty', messages: 0 }]
          : { nodes: [{ slug: 'chain-rule', title: 'Chain rule', status: 'solid', mastery: { effective: 'practicing' } }, { slug: 'stubby', title: 'Stubby', status: 'stub' }] };
      return { ok: true, status: 200, json: async () => body } as Response;
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('opens on Ctrl+K, finds across notebooks, conversations and pages, and goes on Enter', async () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByRole('combobox');
    await screen.findByRole('option', { name: /^Calculus I/ });
    // Empty conversations and stub pages are not destinations.
    expect(screen.queryByRole('option', { name: /t-empty/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /Stubby/ })).toBeNull();

    fireEvent.change(input, { target: { value: 'chain' } });
    const only = screen.getAllByRole('option');
    expect(only.map((o) => o.textContent)).toEqual(['PagesChain rulepracticing']);
    // Actions are there for the empty query too, after the places.
    fireEvent.change(input, { target: { value: 'library' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['ActionsOpen the libraryprogress, reviews, sources']);
    fireEvent.change(input, { target: { value: 'chain' } });
    expect(only[0].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(location.hash).toBe('#/t/t-here/page/chain-rule'));
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('moves the selection with the arrow keys and closes on Escape, returning focus', async () => {
    render(<CommandPalette />);
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    const input = await screen.findByRole('combobox');
    await screen.findByRole('option', { name: /^Calculus I/ });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe('palette-opt-1');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Search/ }));
  });
});
