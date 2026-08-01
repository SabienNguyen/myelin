// @vitest-environment jsdom
// The models popover behind the tutor badge. What these pin: the badge is a real button opening a
// dialog with all five roles; a save PUTs only what changed; an env-shadowed field is disabled and
// says which variable overrides it; a saved API key is never displayed — the server sends a `set`
// flag and the field's whole disclosure is placeholder "saved".
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { TopbarStatus } from '../../src/client/components/TopbarStatus.js';

type EnvOverrides = Partial<Record<string, object>>;
type Available = { ollama?: string[]; openaiCompat?: string[] };
function modelsState(env: EnvOverrides = {}, roles: Record<string, string> = {}, available: Available = {}) {
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
    available,
    savedAt: '~/.config/myelin/settings.json',
  };
}

const emptyUsage = { today: {}, week: {}, cacheHitShare: null };

function stubFetch(
  state = modelsState(), putResponse = state, usage: object = emptyUsage,
  setup: object = { apiKey: { present: false, source: null } },
  apiKeyPut: { ok: boolean; body: object } = { ok: true, body: {} },
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/setup/api-key')) return { ok: apiKeyPut.ok, json: async () => apiKeyPut.body };
    const body = u.endsWith('/api/status') ? { student: 'e2e', tutor: 'claude-sonnet-5' }
      : u.endsWith('/api/setup/models') ? (init?.method === 'PUT' ? putResponse : state)
        : u.endsWith('/api/usage') ? usage
          : u.endsWith('/api/setup') ? setup
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
  it('renders every CALLABLE role with its effective id, off a shared datalist', async () => {
    // quiz_gen is deliberately not among them: nothing calls it (quiz blocks are staged by the
    // tutor as a block tool), so offering it asked the learner to pick a model that could not
    // change anything. The config key still exists for compatibility.
    stubFetch();
    await openPopover();
    expect(screen.queryByLabelText('quiz_gen')).toBeNull();
    for (const role of ['tutor', 'grader', 'card_gen', 'compile']) {
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

  it('shows a dense usage line per role with spend today, cache reads and writes included', async () => {
    const totals = (t: object) => ({ cacheRead: 0, cacheWrite: 0, calls: 1, ...t });
    stubFetch(modelsState(), modelsState(), {
      today: {
        tutor: totals({ in: 11_000, out: 2_130, cacheRead: 33_000, cacheWrite: 4_200 }),
        help: totals({ in: 950, out: 80 }),
      },
      week: {}, cacheHitShare: 0.75,
    });
    await openPopover();
    await screen.findByText('usage today');
    // The raw figures, not just a derived share: cache reads and writes are the numbers a bill
    // (or a local cache's effectiveness) is actually made of.
    screen.getByText('tutor 11k in / 2.1k out · cache 33k read / 4.2k write');
    screen.getByText('help 950 in / 80 out'); // no cache traffic → no cache suffix
  });

  it('an empty ledger renders no usage section at all', async () => {
    stubFetch();
    await openPopover();
    await screen.findByText('provider endpoints'); // dialog fully loaded
    expect(screen.queryByText('usage today')).toBeNull();
  });

  it('Escape closes the dialog and returns focus to the badge', async () => {
    stubFetch();
    await openPopover();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'models' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /configure models/i }));
  });
});

describe('ModelsMenu — live discovery', () => {
  const discovered = () => modelsState({}, {}, {
    ollama: ['qwen3:8b', 'llama3.1:8b'],
    openaiCompat: ['mistralai/mistral-7b'],
  });

  it('discovered models join the shared datalist as routable ids', async () => {
    stubFetch(discovered());
    await openPopover();
    await screen.findByText('installed locally:');
    const options = [...document.querySelectorAll('#model-id-list option')]
      .map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain('ollama:qwen3:8b');
    expect(options).toContain('ollama:llama3.1:8b');
    expect(options).toContain('openai:mistralai/mistral-7b');
    expect(options).toContain('claude-sonnet-5'); // the static entries stay
  });

  it('an installed-locally chip fills the last-focused role input, nothing else', async () => {
    stubFetch(discovered());
    await openPopover();
    await screen.findByText('installed locally:');
    fireEvent.focus(screen.getByLabelText('grader'));
    fireEvent.click(screen.getByRole('button', { name: 'qwen3:8b' }));
    expect((screen.getByLabelText('grader') as HTMLInputElement).value).toBe('ollama:qwen3:8b');
    expect((screen.getByLabelText('tutor') as HTMLInputElement).value).toBe('claude-sonnet-5');
  });

  it('the local preset sets the teaching roles, checks rails, and leaves compile alone', async () => {
    stubFetch(discovered());
    await openPopover();
    await screen.findByText('installed locally:');
    fireEvent.change(screen.getByLabelText('local preset'), { target: { value: 'llama3.1:8b' } });
    fireEvent.click(screen.getByRole('button', { name: 'apply' }));
    for (const r of ['tutor', 'grader', 'card_gen']) {
      expect((screen.getByLabelText(r) as HTMLInputElement).value).toBe('ollama:llama3.1:8b');
    }
    expect((screen.getByLabelText('compile') as HTMLInputElement).value).toBe('claude-sonnet-5');
    expect((screen.getByLabelText('rails') as HTMLInputElement).checked).toBe(true);
  });

  it('nothing discovered means no chips and no preset row — a clean offline dialog', async () => {
    stubFetch();
    await openPopover();
    await screen.findByText('provider endpoints');
    expect(screen.queryByText('installed locally:')).toBeNull();
    expect(screen.queryByLabelText('local preset')).toBeNull();
  });

  // The dialog is where the Anthropic key gets CHANGED after first run — the first-run card only
  // ever sets it once. Same conventions as the other key fields: the value never round-trips,
  // typing means replace, the environment variable shadows the saved one.
  it('a typed Anthropic key rides save through the validating endpoint, then the field clears', async () => {
    const fetchMock = stubFetch(
      modelsState(), modelsState(), emptyUsage,
      { apiKey: { present: true, source: 'saved' } },
    );
    await openPopover();
    const field = await screen.findByLabelText('anthropic api key') as HTMLInputElement;
    await waitFor(() => expect(field.placeholder).toBe('saved — type to replace'));
    fireEvent.change(field, { target: { value: 'sk-ant-new-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await screen.findByText(/saved — takes effect on the next call/);
    const keyPut = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/setup/api-key'));
    expect(JSON.parse(String(keyPut?.[1]?.body))).toEqual({ key: 'sk-ant-new-key' });
    expect(field.value).toBe('');
  });

  it('a rejected key says so by name, after the models half already saved', async () => {
    stubFetch(
      modelsState(), modelsState(), emptyUsage,
      { apiKey: { present: false, source: null } },
      { ok: false, body: { error: 'that key was refused by Anthropic' } },
    );
    await openPopover();
    fireEvent.change(await screen.findByLabelText('anthropic api key'), { target: { value: 'sk-ant-bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await screen.findByText(/models saved, but the Anthropic key was rejected: that key was refused/);
  });

  it('ANTHROPIC_API_KEY in the environment disables the field and says which variable wins', async () => {
    stubFetch(
      modelsState(), modelsState(), emptyUsage,
      { apiKey: { present: true, source: 'environment' } },
    );
    await openPopover();
    const field = await screen.findByLabelText('anthropic api key') as HTMLInputElement;
    await waitFor(() => expect(field.disabled).toBe(true));
    expect(screen.getByText(/overridden by ANTHROPIC_API_KEY in the environment/)).toBeTruthy();
  });

  // Regression: after a pull completes, the teaching roles must be repointed at the model and
  // rails checked. A first cut refreshed discovery AFTER applying the preset, and the refresh
  // (takeState) reset the roles straight back to the saved claude defaults — the preset silently
  // vanished. The refresh must run BEFORE the preset is applied.
  it('the local getter pulls a model, then repoints the teaching roles at it with rails on', async () => {
    // Discovery flips from "nothing installed" to "qwen3:8b installed" once the job lands. The
    // pull is a server-side background job now: POST accepts, GET /pulls reports it done.
    let pulled = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/setup/models/pulls')) {
        return {
          ok: true,
          json: async () => (pulled ? { 'qwen3:8b': { status: 'success', percent: null, error: null, done: true } } : {}),
        };
      }
      if (u.endsWith('/api/setup/models/pull')) { pulled = true; return { ok: true, status: 202, json: async () => ({ started: true }) }; }
      if (u.endsWith('/api/status')) return { ok: true, json: async () => ({ student: 'e2e', tutor: 'claude-sonnet-5' }) };
      if (u.endsWith('/api/setup/models')) {
        return { ok: true, json: async () => modelsState({}, {}, pulled ? { ollama: ['qwen3:8b'] } : {}) };
      }
      if (u.endsWith('/api/usage')) return { ok: true, json: async () => emptyUsage };
      if (u.endsWith('/api/setup')) return { ok: true, json: async () => ({ apiKey: { present: false, source: null } }) };
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await openPopover();
    await screen.findByText('get a local model');

    fireEvent.click(screen.getAllByRole('button', { name: 'Get' })[0]); // qwen3:8b, the first recommended
    await screen.findByText(/qwen3:8b ready/);
    // THE assertion the clobber bug failed: the roles are the pulled model, rails on — not the
    // claude defaults the /api/setup/models refresh returns.
    for (const r of ['tutor', 'grader', 'card_gen']) {
      expect((screen.getByLabelText(r) as HTMLInputElement).value).toBe('ollama:qwen3:8b');
    }
    expect((screen.getByLabelText('compile') as HTMLInputElement).value).toBe('claude-sonnet-5'); // preset leaves compile
    expect((screen.getByLabelText('rails') as HTMLInputElement).checked).toBe(true);
  });
});
