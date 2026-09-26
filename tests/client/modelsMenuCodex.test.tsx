// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TopbarStatus } from '../../src/client/components/TopbarStatus.js';

function stubFetch(connected = false) {
  const env = Object.fromEntries(['OLLAMA_BASE_URL', 'OLLAMA_API_KEY', 'OPENAI_COMPAT_BASE_URL', 'OPENAI_COMPAT_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY'].map(k => [k, { shadowed: false }]));
  const routes: Record<string, unknown> = {
    '/api/status': { student: 'e2e', tutor: 'claude-sonnet-5' },
    '/api/setup/models': { roles: {}, env },
    '/api/usage': { today: {} },
    '/api/setup/openrouter/models': { models: [] },
    '/api/setup': { apiKey: { present: true } },
    '/api/setup/codex': { connected, plan: connected ? 'plus' : null, chatEnabled: false },
    '/api/setup/codex/login': { url: 'https://auth.openai.com/codex/device', code: 'TEST-CODE' },
  };
  const fetched = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const value = routes[String(url)];
    if (!value) throw new Error(`unstubbed fetch ${url}`);
    return Response.json(value);
  });
  vi.stubGlobal('fetch', fetched);
  return fetched;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ModelsMenu — ChatGPT connection section', () => {
  it('opens with the models dialog and starts sign-in only on explicit click', async () => {
    const fetched = stubFetch();
    render(<TopbarStatus />);
    fireEvent.click(await screen.findByRole('button', { name: /^settings/ }));
  fireEvent.click(await screen.findByRole('button', { name: /configure models/i }));
    await screen.findByText('Not connected');
    expect(fetched.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }));
    await screen.findByText('TEST-CODE');
    expect(screen.getByRole('link', { name: 'Open ChatGPT sign-in' }).getAttribute('href')).toBe('https://auth.openai.com/codex/device');
    expect(screen.getByText(/Chat routing is not enabled yet/)).toBeTruthy();
    expect(fetched.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('shows a connected plan with an explicit disconnect control', async () => {
    stubFetch(true);
    render(<TopbarStatus />);
    fireEvent.click(await screen.findByRole('button', { name: /^settings/ }));
  fireEvent.click(await screen.findByRole('button', { name: /configure models/i }));
    await screen.findByText(/Connected · plus/);
    expect(screen.getByRole('button', { name: 'Disconnect ChatGPT' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in with ChatGPT' })).toBeNull();
  });
});
