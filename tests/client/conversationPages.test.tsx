// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ConversationPages } from '../../src/client/components/ConversationPages.js';
import { panelBus } from '../../src/client/lib/panelBus.js';

const tool = (name: string, slug: string) =>
  ({ type: `tool-${name}`, toolCallId: `c-${name}-${slug}`, state: 'output-available', input: { slug }, output: {} });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ConversationPages', () => {
  it('lists the pages the conversation worked on, with their titles and levels, and opens one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ nodes: [
        { slug: 'chain-rule', title: 'Chain rule', mastery: { effective: 'practicing' } },
        { slug: 'limits', title: 'Limits', mastery: { effective: 'mastered' } },
      ] }),
    })));
    const messages = [
      { id: 'a', role: 'assistant', parts: [tool('read_page', 'chain-rule'), tool('record_evidence', 'limits'), tool('read_page', 'chain-rule')] },
    ] as any;
    const opened: string[] = [];
    const off = panelBus.subscribe((e) => { if (e.type === 'openPage') opened.push(e.slug); });
    render(<ConversationPages messages={messages} />);
    const chain = await screen.findByRole('button', { name: /Chain rule/ });
    expect(chain.textContent).toContain('practicing');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Chain rulepracticing', 'Limitsmastered']);
    fireEvent.click(chain);
    expect(opened).toEqual(['chain-rule']);
    off();
  });

  it('refetches levels when a turn settles, not while it runs', async () => {
    let level = 'exposed';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ nodes: [{ slug: 'limits', title: 'Limits', mastery: { effective: level } }] }),
    })));
    const messages = [{ id: 'a', role: 'assistant', parts: [tool('read_page', 'limits')] }] as any;
    const { rerender } = render(<ConversationPages messages={messages} isRunning={false} />);
    expect((await screen.findByRole('button', { name: /Limits/ })).textContent).toContain('seen');
    rerender(<ConversationPages messages={messages} isRunning />);
    level = 'practicing';
    rerender(<ConversationPages messages={messages} isRunning={false} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Limits/ }).textContent).toContain('practicing'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('renders nothing for a conversation that has not touched a page', () => {
    vi.stubGlobal('fetch', vi.fn());
    const { container } = render(<ConversationPages messages={[{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as any} />);
    expect(container.innerHTML).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });
});
