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
function modelsState(
  env: EnvOverrides = {}, roles: Record<string, string> = {}, available: Available = {},
  windows: Record<string, number> = {},
) {
  const effective = {
    tutor: 'claude-sonnet-5', grader: 'claude-haiku-4-5', quiz_gen: 'claude-sonnet-5',
    card_gen: 'claude-haiku-4-5', compile: 'claude-sonnet-5', ...roles,
  };
  return {
    roles: Object.fromEntries(Object.entries(effective).map(([r, m]) =>
      [r, { effective: m, saved: null, contextTokens: windows[r] ?? null }])),
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
  it('separates the provider from the model id and saves the compatible routed id', async () => {
    const mock = stubFetch(modelsState({}, { tutor: 'openrouter:vendor/inkling:free', grader: 'ollama:qwen3:8b' }));
    await openPopover();
    await waitFor(() => expect((screen.getByLabelText('tutor provider') as HTMLSelectElement).value).toBe('openrouter'));
    expect((screen.getByLabelText('tutor') as HTMLInputElement).value).toBe('vendor/inkling:free');
    expect((screen.getByLabelText('grader') as HTMLInputElement).value).toBe('qwen3:8b');
    fireEvent.change(screen.getByLabelText('grader provider'), { target: { value: 'openrouter' } });
    fireEvent.change(screen.getByLabelText('grader'), { target: { value: 'vendor/other:free' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await screen.findByText(/saved — takes effect/);
    const put = mock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body)).models).toEqual({ grader: 'openrouter:vendor/other:free' });
  });

  it('recognizes pasted legacy route prefixes and updates the provider without doubling the prefix', async () => {
    const mock = stubFetch();
    await openPopover();
    fireEvent.change(screen.getByLabelText('tutor'), { target: { value: 'openrouter:vendor/model:free' } });
    expect((screen.getByLabelText('tutor provider') as HTMLSelectElement).value).toBe('openrouter');
    expect((screen.getByLabelText('tutor') as HTMLInputElement).value).toBe('vendor/model:free');
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await screen.findByText(/saved — takes effect/);
    const put = mock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body)).models).toEqual({ tutor: 'openrouter:vendor/model:free' });
  });

  // The window used to be reachable from harness.config.json alone, which left a learner on a
  // small-window model no supported way to tune what protects them from overflow.
  it('prefills each role context window and sends a changed one as a number', async () => {
    const mock = stubFetch(modelsState({}, {}, {}, { tutor: 8192 }));
    await openPopover();
    const tutorWindow = await screen.findByLabelText('tutor context') as HTMLInputElement;
    await waitFor(() => expect(tutorWindow.value).toBe('8192'));
    // The field, not a JS check, is what refuses a fraction or a zero: the save handler sends
    // whatever survives submit, and the PUT refuses anything that still gets past.
    expect([tutorWindow.type, tutorWindow.min, tutorWindow.step]).toEqual(['number', '1', '1']);
    expect((screen.getByLabelText('grader context') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('grader context'), { target: { value: '32768' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await screen.findByText(/saved — takes effect/);
    const put = mock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body)).contextTokens).toEqual({ grader: 32768 });
  });

  it('an emptied window sends null, so a save can take a declared window back off', async () => {
    const mock = stubFetch(modelsState({}, {}, {}, { tutor: 8192 }));
    await openPopover();
    await waitFor(() => expect((screen.getByLabelText('tutor context') as HTMLInputElement).value).toBe('8192'));
    fireEvent.change(screen.getByLabelText('tutor context'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await screen.findByText(/saved — takes effect/);
    const put = mock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body)).contextTokens).toEqual({ tutor: null });
  });

  it('shows catalog discovery errors distinctly from an empty free list', async () => {
    const mock = stubFetch();
    const fallback = mock.getMockImplementation()!;
    mock.mockImplementation(async (url, init) => url.endsWith('/api/setup/openrouter/models')
      ? { ok: false, json: async () => ({ error: 'OpenRouter catalog unavailable' }) }
      : fallback(url, init));
    await openPopover();
    await screen.findByText(/OpenRouter catalog unavailable/);
    expect(screen.queryByText(/none listed right now/)).toBeNull();
    screen.getByText(/catalog.*does not guarantee.*access/i);
  });

  it('saves the dedicated OpenRouter key from a password field', async () => {
    const mock = stubFetch();
    await openPopover();
    const key = await screen.findByLabelText('openrouter api key') as HTMLInputElement;
    expect(key.type).toBe('password');
    fireEvent.change(key, { target: { value: 'test-router-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await screen.findByText(/saved — takes effect/);
    const put = mock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body)).env).toEqual({ OPENROUTER_API_KEY: 'test-router-key' });
  });
  // Groq used to be reachable only by typing its base URL into the one OpenAI-compatible slot.
  it('picks Groq as a provider, keeps the vendor slash in the id, and saves the key with it', async () => {
    const mock = stubFetch();
    await openPopover();
    fireEvent.change(await screen.findByLabelText('tutor provider'), { target: { value: 'groq' } });
    fireEvent.change(screen.getByLabelText('tutor'), { target: { value: 'openai/gpt-oss-120b' } });
    const key = screen.getByLabelText('groq api key') as HTMLInputElement;
    expect(key.type).toBe('password');
    fireEvent.change(key, { target: { value: 'gsk-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await screen.findByText(/saved — takes effect/);
    const body = JSON.parse(String(mock.mock.calls.find(([, init]) => init?.method === 'PUT')?.[1]?.body));
    expect(body.models).toEqual({ tutor: 'groq:openai/gpt-oss-120b' });
    expect(body.env).toEqual({ GROQ_API_KEY: 'gsk-test' });
  });

  it('renders every CALLABLE role with its effective id, with provider-specific suggestions', async () => {
    // quiz_gen is deliberately not among them: nothing calls it (quiz blocks are staged by the
    // tutor as a block tool), so offering it asked the learner to pick a model that could not
    // change anything. The config key still exists for compatibility.
    stubFetch();
    await openPopover();
    expect(screen.queryByLabelText('quiz_gen')).toBeNull();
    for (const role of ['tutor', 'grader', 'card_gen', 'compile']) {
      const input = await screen.findByLabelText(role) as HTMLInputElement;
      expect(input.getAttribute('list')).toBe('model-id-list-anthropic');
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
      contextTokens: {}, // no window touched, so the group carries nothing
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

// The three GET reads on dialog open (models, usage, setup) used to end in a bare
// `.catch(() => {})`: the dialog opened anyway with `loaded`/`roles`/`anthropicMeta` left at their
// unpopulated defaults, and Save stayed clickable — pressing it would diff empty local state against
// nothing and could wipe roles the server actually had set.
describe('ModelsMenu — a failed dialog-open read must not leave Save clickable', () => {
  function stubFailingModelsRead() {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/setup/models')) throw new TypeError('fetch failed');
      const body = u.endsWith('/api/status') ? { student: 'e2e', tutor: 'claude-sonnet-5' }
        : u.endsWith('/api/usage') ? emptyUsage
          : u.endsWith('/api/setup') ? { apiKey: { present: false, source: null } }
            : {};
      return { ok: true, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('a failed /api/setup/models read on open disables Save and shows a note', async () => {
    stubFailingModelsRead();
    await openPopover();
    const save = await screen.findByRole('button', { name: 'save' }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(screen.getByText(/could not load current models/)).toBeTruthy();
  });

  it('a successful open, then a failed local-getter refresh, disables Save and does not print "ready"', async () => {
    let modelsReads = 0;
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/setup/models')) {
        modelsReads += 1;
        // First read (dialog open) succeeds; configureLocal's refresh (the second) fails.
        if (modelsReads === 1) return { ok: true, json: async () => modelsState({}, {}, { ollama: ['mistral:7b'] }) };
        throw new TypeError('fetch failed');
      }
      const body = u.endsWith('/api/status') ? { student: 'e2e', tutor: 'claude-sonnet-5' }
        : u.endsWith('/api/usage') ? emptyUsage
          : u.endsWith('/api/setup') ? { apiKey: { present: false, source: null } }
            : {};
      return { ok: true, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);
    await openPopover();
    const save = await screen.findByRole('button', { name: 'save' }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));

    fireEvent.click(await screen.findByRole('button', { name: 'use it' }));

    await waitFor(() => expect(save.disabled).toBe(true));
    expect(screen.queryByText(/ready — press save/)).toBeNull();
    expect(screen.getByText(/reading back current models failed/)).toBeTruthy();
  });
});

describe('ModelsMenu — live discovery', () => {
  const discovered = () => modelsState({}, {}, {
    ollama: ['qwen3:8b', 'llama3.1:8b'],
    openaiCompat: ['mistralai/mistral-7b'],
  });

  it('discovered models join provider datalists without routing prefixes', async () => {
    stubFetch(discovered());
    await openPopover();
    await screen.findByText('installed locally:');
    const options = [...document.querySelectorAll('datalist option')]
      .map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain('qwen3:8b');
    expect(options).toContain('llama3.1:8b');
    expect(options).toContain('mistralai/mistral-7b');
    expect(options).toContain('claude-sonnet-5'); // the static entries stay
  });

  it('an installed-locally chip fills the last-focused role input, nothing else', async () => {
    stubFetch(discovered());
    await openPopover();
    await screen.findByText('installed locally:');
    fireEvent.focus(screen.getByLabelText('grader'));
    fireEvent.click(screen.getByRole('button', { name: 'qwen3:8b' }));
    expect((screen.getByLabelText('grader') as HTMLInputElement).value).toBe('qwen3:8b');
    expect((screen.getByLabelText('grader' + ' provider') as HTMLSelectElement).value).toBe('ollama');
    expect((screen.getByLabelText('tutor') as HTMLInputElement).value).toBe('claude-sonnet-5');
  });

  it('the local preset sets the teaching roles and leaves compile alone', async () => {
    stubFetch(discovered());
    await openPopover();
    await screen.findByText('installed locally:');
    fireEvent.change(screen.getByLabelText('local preset'), { target: { value: 'llama3.1:8b' } });
    fireEvent.click(screen.getByRole('button', { name: 'apply' }));
    for (const r of ['tutor', 'grader', 'card_gen']) {
      expect((screen.getByLabelText(r) as HTMLInputElement).value).toBe('llama3.1:8b');
    expect((screen.getByLabelText(r + ' provider') as HTMLSelectElement).value).toBe('ollama');
    }
    expect((screen.getByLabelText('compile') as HTMLInputElement).value).toBe('claude-sonnet-5');
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

  // Regression: after a pull completes, the teaching roles must be repointed at the model. A
  // first cut refreshed discovery AFTER applying the preset, and the refresh
  // (takeState) reset the roles straight back to the saved claude defaults — the preset silently
  // vanished. The refresh must run BEFORE the preset is applied.
  it('the local getter pulls a model, then repoints the teaching roles at it', async () => {
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
    // THE assertion the clobber bug failed: the roles are the pulled model — not the claude
    // defaults the /api/setup/models refresh returns.
    for (const r of ['tutor', 'grader', 'card_gen']) {
      expect((screen.getByLabelText(r) as HTMLInputElement).value).toBe('qwen3:8b');
    expect((screen.getByLabelText(r + ' provider') as HTMLSelectElement).value).toBe('ollama');
    }
    expect((screen.getByLabelText('compile') as HTMLInputElement).value).toBe('claude-sonnet-5'); // preset leaves compile
  });
});
