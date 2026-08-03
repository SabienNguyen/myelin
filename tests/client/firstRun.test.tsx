// @vitest-environment jsdom
// The first-run gate. What these pin: blocked state renders BOTH ways in — an Anthropic key and
// a local/OpenAI-compatible model — because "Anthropic key or nothing" walled out exactly the
// local-model users the harness serves; the local path points every role at the typed id through
// the models endpoint and lifts the gate off the re-read setup state; the compat fields appear
// only once an openai: id makes them relevant.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { FirstRun } from '../../src/client/components/FirstRun.js';

const blockedState = {
  apiKey: { rolesNeeding: ['tutor'], present: false, source: null, savedAt: '~/.config/myelin/credentials.json' },
  vault: { path: '/home/x/Myelin', exists: true },
  config: { path: '', found: false },
  blocked: true,
};

function stubFetch(modelsPut: { ok: boolean; body?: object } = { ok: true }, modelsGet: object = {}) {
  let setupReads = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/setup/models')) {
      if (init?.method === 'PUT') return { ok: modelsPut.ok, json: async () => modelsPut.body ?? {} };
      return { ok: true, json: async () => modelsGet };
    }
    if (u.endsWith('/api/setup')) {
      // First read blocks; the read AFTER a successful local save comes back unblocked, the way
      // the server's needsApiKey computes it once no role routes through Anthropic.
      setupReads++;
      return { ok: true, json: async () => (setupReads === 1 || init?.method === 'PUT' ? blockedState : { ...blockedState, blocked: false }) };
    }
    if (u.endsWith('/api/setup/api-key')) return { ok: true, json: async () => ({ ...blockedState, blocked: false }) };
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('FirstRun — two ways through the gate', () => {
  it('blocked state offers the Anthropic key AND the local/compat model path', async () => {
    stubFetch();
    render(<FirstRun><p>the app</p></FirstRun>);
    await screen.findByText('Ready when you are');
    expect(screen.getByLabelText(/Anthropic API key/)).toBeTruthy();
    expect(screen.getByLabelText(/local or OpenAI-compatible model/)).toBeTruthy();
    expect(screen.queryByText('the app')).toBeNull();
  });

  it('the local path points every role at the typed id and lifts the gate', async () => {
    const fetchMock = stubFetch();
    render(<FirstRun><p>the app</p></FirstRun>);
    fireEvent.change(await screen.findByLabelText(/local or OpenAI-compatible model/), {
      target: { value: 'ollama:qwen3:8b' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use it' }));
    await screen.findByText('the app');
    const put = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith('/api/setup/models') && i?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      models: {
        tutor: 'ollama:qwen3:8b', grader: 'ollama:qwen3:8b', quiz_gen: 'ollama:qwen3:8b',
        card_gen: 'ollama:qwen3:8b', compile: 'ollama:qwen3:8b',
      },
    });
  });

  it('an openai: id reveals the base-url and key fields, and they ride the save as env', async () => {
    const fetchMock = stubFetch();
    render(<FirstRun><p>the app</p></FirstRun>);
    const idField = await screen.findByLabelText(/local or OpenAI-compatible model/);
    expect(screen.queryByLabelText('OpenAI-compatible base URL')).toBeNull(); // hidden until relevant
    fireEvent.change(idField, { target: { value: 'openai:deepseek/deepseek-chat' } });
    fireEvent.change(screen.getByLabelText('OpenAI-compatible base URL'), {
      target: { value: 'https://openrouter.ai/api/v1' },
    });
    fireEvent.change(screen.getByLabelText('OpenAI-compatible API key'), { target: { value: 'or-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use it' }));
    await screen.findByText('the app');
    const put = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith('/api/setup/models') && i?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body)).env).toEqual({
      OPENAI_COMPAT_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_COMPAT_API_KEY: 'or-key',
    });
  });

  it('a recommended model already on disk offers "use it", not a re-download', async () => {
    // The card once hardcoded installed={[]}, so someone who already had a curated model pulled
    // was offered a multi-GB "Get" for bytes on their disk. Discovery is keyless — the gate
    // blocks model CALLS, not the tag probe — so the on-ramp can know and say "use it".
    stubFetch({ ok: true }, { available: { ollama: ['mistral:7b'] } });
    render(<FirstRun><p>the app</p></FirstRun>);
    await screen.findByText('Ready when you are');
    const row = (await screen.findByText('Mistral 7B')).closest('.local-getter-row') as HTMLElement;
    await waitFor(() => expect(within(row).getByRole('button', { name: 'use it' })).toBeTruthy());
    expect(within(row).queryByText(/download/)).toBeNull();
  });

  it('a rejected local save surfaces the server message and keeps the gate up', async () => {
    stubFetch({ ok: false, body: { error: 'model "openai:x" needs an OpenAI-compatible base URL' } });
    render(<FirstRun><p>the app</p></FirstRun>);
    fireEvent.change(await screen.findByLabelText(/local or OpenAI-compatible model/), {
      target: { value: 'openai:x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use it' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/needs an OpenAI-compatible base URL/));
    expect(screen.queryByText('the app')).toBeNull();
  });
});
