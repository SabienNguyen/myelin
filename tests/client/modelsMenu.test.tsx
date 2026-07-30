// @vitest-environment jsdom
// The models popover behind the tutor badge. What these pin: the badge is a real button opening a
// dialog with all five roles; a save PUTs only what changed; an env-shadowed field is disabled and
// says which variable overrides it; a saved API key is never displayed — the server sends a `set`
// flag and the field's whole disclosure is placeholder "saved".
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { TopbarStatus } from '../../src/client/components/TopbarStatus.js';

type EnvOverrides = Partial<Record<string, object>>;
function modelsState(env: EnvOverrides = {}, roles: Record<string, string> = {}) {
  const effective = {
    tutor: 'claude-sonnet-5', grader: 'claude-haiku-4-5', quiz_gen: 'claude-sonnet-5',
    card_gen: 'claude-haiku-4-5', compile: 'claude-sonnet-5', ...roles,
  };
  return {
    roles: Object.fromEntries(Object.entries(effective).map(([r, m]) => [r, { effective: m, saved: null }])),
    env: {
      OLLAMA_BASE_URL: { value: '', shadowed: false },
      OLLAMA_API_KEY: { set: false, shadowed: false },
      OPENAI_COMPAT_BASE_URL: { value: '', shadowed: false },
      OPENAI_COMPAT_API_KEY: { set: false, shadowed: false },
      ...env,
    },
    savedAt: '~/.config/myelin/settings.json',
  };
}

function stubFetch(state = modelsState(), putResponse = state) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = u.endsWith('/api/status') ? { student: 'e2e', tutor: 'claude-sonnet-5' }
      : u.endsWith('/api/setup/models') ? (init?.method === 'PUT' ? putResponse : state)
        : {};
    return { ok: true, json: async () => body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openPopover() {
  render(<TopbarStatus />);
  fireEvent.click(await screen.findByRole('button', { name: /configure models/i }));
  return screen.findByRole('dialog', { name: 'models' });
}

describe('ModelsMenu — the tutor badge opens the model configuration dialog', () => {
  it('renders all five roles with their effective ids, off a shared datalist', async () => {
    stubFetch();
    await openPopover();
    for (const role of ['tutor', 'grader', 'quiz_gen', 'card_gen', 'compile']) {
      const input = await screen.findByLabelText(role) as HTMLInputElement;
      expect(input.getAttribute('list')).toBe('model-id-list');
    }
    await waitFor(() => {
      expect((screen.getByLabelText('grader') as HTMLInputElement).value).toBe('claude-haiku-4-5');
      expect((screen.getByLabelText('tutor') as HTMLInputElement).value).toBe('claude-sonnet-5');
    });
  });

  it('save PUTs only what changed, then shows the quiet confirmation', async () => {
    const saved = modelsState({}, { grader: 'openai:test/model' });
    const fetchMock = stubFetch(modelsState(), saved);
    await openPopover();
    await waitFor(() => expect((screen.getByLabelText('grader') as HTMLInputElement).value).toBe('claude-haiku-4-5'));

    fireEvent.change(screen.getByLabelText('grader'), { target: { value: 'openai:test/model' } });
    fireEvent.change(screen.getByLabelText('openai-compatible base url'), {
      target: { value: 'https://x.example/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await screen.findByText(/saved — takes effect on the next call/);
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(putCall?.[0]).toBe('/api/setup/models');
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      models: { grader: 'openai:test/model' },
      env: { OPENAI_COMPAT_BASE_URL: 'https://x.example/v1' },
    });
  });

  it('an env-shadowed field is disabled and names the variable that overrides it', async () => {
    stubFetch(modelsState({ OLLAMA_BASE_URL: { value: 'http://saved:1/v1', shadowed: true } }));
    await openPopover();
    const input = await screen.findByLabelText('ollama base url') as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(true));
    screen.getByText('overridden by OLLAMA_BASE_URL in the environment');
  });

  it('a saved API key is never displayed — empty password field, placeholder "saved"', async () => {
    stubFetch(modelsState({ OPENAI_COMPAT_API_KEY: { set: true, shadowed: false } }));
    await openPopover();
    const input = await screen.findByLabelText('openai-compatible api key') as HTMLInputElement;
    expect(input.type).toBe('password');
    await waitFor(() => expect(input.placeholder).toBe('saved'));
    expect(input.value).toBe('');
  });

  it('Escape closes the dialog and returns focus to the badge', async () => {
    stubFetch();
    await openPopover();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'models' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /configure models/i }));
  });
});
