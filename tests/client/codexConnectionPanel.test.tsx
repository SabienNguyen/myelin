// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('ChatGPT connection panel', () => {
  it('keeps login explicit and distinguishes connected from usable for chat', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json(
      init?.method === 'POST' ? { url: 'https://auth.openai.com/codex/device', code: 'TEST-CODE' }
        : { connected: false, plan: null, chatEnabled: false },
    ));
    vi.stubGlobal('fetch', fetcher);
    const module = await import('../../src/client/components/CodexConnectionPanel.js').catch(() => ({}));
    expect(module).toHaveProperty('CodexConnectionPanel');
    const { CodexConnectionPanel } = module as typeof import('../../src/client/components/CodexConnectionPanel.js');
    render(<CodexConnectionPanel />);
    await screen.findByText('Not connected');
    expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }));
    await screen.findByText('TEST-CODE');
    expect(screen.getByRole('link', { name: 'Open ChatGPT sign-in' }).getAttribute('href')).toBe('https://auth.openai.com/codex/device');
    expect(screen.getByText(/Chat routing is not enabled yet/)).toBeTruthy();
    expect(fetcher.mock.calls.some(([url]) => String(url) === '/api/setup/models')).toBe(false);
  });

  it('shows an actionable status failure without a misleading connected state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    const { CodexConnectionPanel } = await import('../../src/client/components/CodexConnectionPanel.js');
    render(<CodexConnectionPanel />);
    await screen.findByRole('alert');
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('keeps polling through a failed status read, and a connected read ends the wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const statuses: (Status | 'blip')[] = [{ connected: false, plan: null }, 'blip', { connected: true, plan: 'plus' }];
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ url: 'https://auth.openai.com/codex/device', code: 'TEST-CODE' });
      const next = statuses.shift() ?? { connected: true, plan: 'plus' };
      return next === 'blip' ? Response.json({ error: 'Could not check Codex.' }, { status: 503 }) : Response.json(next);
    });
    vi.stubGlobal('fetch', fetcher);
    const { CodexConnectionPanel } = await import('../../src/client/components/CodexConnectionPanel.js');
    render(<CodexConnectionPanel />);
    await act(async () => {});
    await act(async () => { screen.getByRole('button', { name: 'Sign in with ChatGPT' }).click(); });
    expect(screen.getByText('TEST-CODE')).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByRole('alert').textContent).toBe('Could not check Codex. Still waiting.');
    expect(screen.getByText('TEST-CODE')).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByText('Connected · plus')).toBeTruthy();
    expect(screen.queryByText(/Waiting for authorization/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel sign-in' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect ChatGPT' })).toBeTruthy();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('shows the server’s own reason when an action fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => (init?.method === 'DELETE'
      ? Response.json({ error: 'Could not disconnect ChatGPT. Restart Myelin and try again.' }, { status: 503 })
      : Response.json({ connected: true, plan: 'plus' }))));
    const { CodexConnectionPanel } = await import('../../src/client/components/CodexConnectionPanel.js');
    render(<CodexConnectionPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect ChatGPT' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not disconnect ChatGPT. Restart Myelin and try again.');
    expect(screen.getByText('Connected · plus')).toBeTruthy();
  });
});

type Status = { connected: boolean; plan: string | null; error?: string };
