// @vitest-environment jsdom
// Runtime loads a thread's saved messages once before mounting the chat. A failed load used to be
// swallowed into `setInitial([])`, which rendered exactly like an empty thread — reopening a
// conversation with real history on a flaky connection looked like the history was gone, with no
// sign anything had failed. This pins that a load failure renders a visible error instead.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { Runtime } from '../../src/client/runtime.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Runtime — a thread load failure is visible, not a blank transcript', () => {
  it('an unreachable server renders an error instead of mounting the chat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    render(<Runtime mode="learn"><p>chat mounted</p></Runtime>);
    const err = await screen.findByRole('status');
    expect(err.textContent).toMatch(/can.t reach the harness/i);
    expect(screen.queryByText('chat mounted')).toBeNull();
  });

  it('a non-2xx thread response renders an error instead of mounting the chat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    render(<Runtime mode="learn"><p>chat mounted</p></Runtime>);
    const err = await screen.findByRole('status');
    expect(err.textContent).toMatch(/this conversation/i);
    expect(screen.queryByText('chat mounted')).toBeNull();
  });

  it('switching threadId clears a prior error and re-fetches', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => [] };
    }));
    const { rerender } = render(<Runtime mode="learn" threadId="a"><p>chat mounted</p></Runtime>);
    await screen.findByRole('status');
    rerender(<Runtime mode="learn" threadId="b"><p>chat mounted</p></Runtime>);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});
