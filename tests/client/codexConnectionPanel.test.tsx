// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
});
