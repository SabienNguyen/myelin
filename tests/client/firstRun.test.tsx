// @vitest-environment jsdom
// The first-run gate. What these pin: blocked state renders BOTH ways in — an Anthropic key and
// a local/OpenAI-compatible model — because "Anthropic key or nothing" walled out exactly the
// local-model users the harness serves; the local path points every role at the typed id through
// the models endpoint and lifts the gate off the re-read setup state; the compat fields appear
// only for an `openai:` id, since that is the only prefix models.ts routes to a remote endpoint —
// a bare id routes through Anthropic and would silently strand a typed base URL.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { FirstRun } from '../../src/client/components/FirstRun.js';

const blockedState = {
  apiKey: { rolesNeeding: ['tutor'], present: false, source: null, savedAt: '~/.config/myelin/credentials.json' },
  vault: { path: '/home/x/Myelin', exists: true },
  config: { path: '', found: false },
  blocked: true,
};

/**
 * `/api/setup`'s `blocked` is computed here from the last models PUT, the way the real server
 * computes it from whether any role still routes through Anthropic with no key: every role must
 * carry `ollama:` or `openai:`, or an API key must have been saved, or the gate stays up. A prior
 * version of this stub returned `blocked: false` on the second read by call count regardless of
 * what was saved, which could not have caught FirstRun rendering a still-blocked re-read as a
 * silent no-op — the very bug this file now has a test for.
 */
function stubFetch(modelsPut: { ok: boolean; body?: object } = { ok: true }, modelsGet: object = {}) {
  let lastPutModels: string[] | null = null;
  let keySaved = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/setup/models')) {
      if (init?.method === 'PUT') {
        const body = init.body ? JSON.parse(String(init.body)) : {};
        lastPutModels = body.models ? (Object.values(body.models) as string[]) : null;
        return { ok: modelsPut.ok, json: async () => modelsPut.body ?? {} };
      }
      return { ok: true, json: async () => modelsGet };
    }
    if (u.endsWith('/api/setup')) {
      const blocked = keySaved ? false
        : lastPutModels ? !lastPutModels.every((id) => id.startsWith('ollama:') || id.startsWith('openai:'))
          : true;
      return { ok: true, json: async () => ({ ...blockedState, blocked }) };
    }
    if (u.endsWith('/api/setup/api-key')) {
      keySaved = true;
      return { ok: true, json: async () => ({ ...blockedState, blocked: false }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('FirstRun — two ways through the gate', () => {
  it('configures every learning role on the free router with a dedicated key', async () => {
    const mock = stubFetch();
    render(<FirstRun><p>the app</p></FirstRun>);
    fireEvent.change(await screen.findByLabelText('OpenRouter API key'), { target: { value: 'test-router-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use free models' }));
    await waitFor(() => expect(mock.mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(true));
    const put = mock.mock.calls.find(([, i]) => i?.method === 'PUT');
    const body = JSON.parse(String(put?.[1]?.body));
    expect(Object.values(body.models)).toEqual(Array(5).fill('openrouter:openrouter/free'));
    expect(body.env).toEqual({ OPENROUTER_API_KEY: 'test-router-key' });
    expect(body.tutorRails).toBe(true);
  });

  // Every role defaults to OpenRouter now, so a saved Anthropic key alone satisfies nothing: the
  // roles still route to OpenRouter, the gate stays up, and the card re-renders with no message.
  // Choosing the Anthropic card has to mean "run on Claude", not just "store this key".
  it('an Anthropic key also moves the roles onto Claude, with the tutor off rails', async () => {
    const mock = stubFetch();
    render(<FirstRun><p>the app</p></FirstRun>);
    fireEvent.change(await screen.findByLabelText(/Anthropic API key/), { target: { value: 'sk-ant-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('the app')).toBeTruthy());
    const put = mock.mock.calls.find(([u, i]) => String(u).endsWith('/api/setup/models') && i?.method === 'PUT');
    const body = JSON.parse(String(put?.[1]?.body));
    expect(body.models).toEqual({
      tutor: 'claude-sonnet-5', grader: 'claude-haiku-4-5', quiz_gen: 'claude-sonnet-5',
      card_gen: 'claude-haiku-4-5', compile: 'claude-sonnet-5',
    });
    expect(body.tutorRails).toBe(false);
  });
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

/**
 * A bare id (no `ollama:`/`openai:` prefix) routes through Anthropic per models.ts's
 * modelRouteFor — it is not a remote-endpoint id, so the compat fields must NOT appear for it,
 * and saving it leaves the Anthropic route unsatisfied. The card has to say so, naming which
 * roles still need a working model, rather than silently re-rendering the same inputs.
 */
describe('reaching a remote endpoint', () => {
  it('does not reveal the compat fields for a bare vendor id — only openai: does', async () => {
    stubFetch();
    render(<FirstRun><p>the app</p></FirstRun>);
    fireEvent.change(await screen.findByLabelText(/local or OpenAI-compatible model/), {
      target: { value: 'deepseek/deepseek-chat' },
    });
    expect(screen.queryByLabelText('OpenAI-compatible base URL')).toBeNull();
  });

  it('leaves an ollama: first run a single input', async () => {
    stubFetch();
    render(<FirstRun><p>the app</p></FirstRun>);
    fireEvent.change(await screen.findByLabelText(/local or OpenAI-compatible model/), {
      target: { value: 'ollama:qwen3:8b' },
    });
    expect(screen.queryByLabelText('OpenAI-compatible base URL')).toBeNull();
  });

  it('a bare id saves but leaves the gate up, and says which roles still need a model', async () => {
    stubFetch();
    render(<FirstRun><p>the app</p></FirstRun>);
    fireEvent.change(await screen.findByLabelText(/local or OpenAI-compatible model/), {
      target: { value: 'deepseek/deepseek-chat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use it' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/tutor/));
    expect(screen.queryByText('the app')).toBeNull();
  });
});
