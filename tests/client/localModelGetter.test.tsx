// @vitest-environment jsdom
// The pull-and-configure list. What these pin: a not-installed model shows "Get" and pulls with a
// progress bar, calling onConfigured on success; an already-installed model shows "use it" and
// configures with no pull; a failed pull surfaces the error and does NOT configure.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { LocalModelGetter } from '../../src/client/components/LocalModelGetter.js';
import { RECOMMENDED_LOCAL_MODELS } from '../../src/shared/localModels.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const first = RECOMMENDED_LOCAL_MODELS[0]; // 'qwen3:8b'

/** The new wire: POST starts a server-side job (202), GET /pulls serves progress snapshots.
 *  `states` plays per GET once a pull has started; the last state repeats. */
function stubPull(states: object[], ok = true) {
  let started = false;
  let i = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url) === '/api/setup/models/pulls') {
      if (!started || states.length === 0) return { ok: true, status: 200, json: async () => ({}) };
      const state = states[Math.min(i++, states.length - 1)];
      return { ok: true, status: 200, json: async () => ({ [first.id]: state }) };
    }
    if (init?.method === 'POST') {
      if (!ok) return { ok: false, status: 502, json: async () => ({ error: 'install ollama from ollama.com' }) };
      started = true;
      return { ok: true, status: 202, json: async () => ({ started: true }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('LocalModelGetter', () => {
  it('lists the recommended models with a Get button when none are installed', () => {
    render(<LocalModelGetter installed={[]} onConfigured={() => {}} />);
    for (const m of RECOMMENDED_LOCAL_MODELS) expect(screen.getByText(m.label)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Get' })).toHaveLength(RECOMMENDED_LOCAL_MODELS.length);
  });

  it('an already-installed model shows "use it" and configures with no pull', () => {
    const onConfigured = vi.fn();
    const fetchMock = stubPull([]);
    render(<LocalModelGetter installed={[first.id]} onConfigured={onConfigured} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'use it' })[0]);
    expect(onConfigured).toHaveBeenCalledWith(first.id);
    // "use it" never pulls — the only traffic is the mount-time look for an in-flight download.
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'POST')).toHaveLength(0);
  });

  it('Get starts the background job, shows its progress, then configures when it lands', async () => {
    const onConfigured = vi.fn();
    stubPull([
      { status: 'downloading', percent: 60, error: null, done: false },
      { status: 'success', percent: null, error: null, done: true },
    ]);
    render(<LocalModelGetter installed={[]} onConfigured={onConfigured} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Get' })[0]); // qwen3:8b
    await waitFor(() => expect(onConfigured).toHaveBeenCalledWith(first.id), { timeout: 4000 });
  });

  it('re-attaches to a download still running from an earlier surface', async () => {
    const onConfigured = vi.fn();
    const states = [
      { status: 'downloading', percent: 41, error: null, done: false }, // the mount-time find
      { status: 'downloading', percent: 41, error: null, done: false }, // watch's immediate poll
      { status: 'success', percent: null, error: null, done: true },    // the 1s-later poll
    ];
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url) === '/api/setup/models/pulls') {
        return { ok: true, status: 200, json: async () => ({ [first.id]: states[Math.min(i++, states.length - 1)] }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
    render(<LocalModelGetter installed={[]} onConfigured={onConfigured} />);
    // The bar reappears with no click — the job was found, not restarted…
    await screen.findByRole('status', { name: `downloading ${first.label}` });
    await screen.findByText(/41%/);
    // …and completion still configures.
    await waitFor(() => expect(onConfigured).toHaveBeenCalledWith(first.id), { timeout: 4000 });
  });

  it('a failed pull surfaces the error and does not configure', async () => {
    const onConfigured = vi.fn();
    stubPull([], false);
    render(<LocalModelGetter installed={[]} onConfigured={onConfigured} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Get' })[0]);
    await screen.findByText(/ollama\.com/);
    expect(onConfigured).not.toHaveBeenCalled();
  });
});

/**
 * The reported bug: a learner who has never installed Ollama clicked "Get" and got an error telling
 * them to go install something, with no way back — the "choose a model, we install it" promise
 * dead-ended at the one person it was written for. These pin the recovery instead of the error.
 */
describe('LocalModelGetter when Ollama is missing', () => {
  /** Routes by URL so one stub can serve the pull, the job poll, the state poll, and the start
   *  call. `daemon` is read fresh each call, so a test can bring Ollama "up" mid-flight. */
  function stubOllama(opts: { reason: string; daemon: () => 'up' | 'down'; install?: unknown }) {
    const calls: string[] = [];
    let pullStarted = false;
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/api/setup/ollama') {
        return { ok: true, status: 200, json: async () => ({ state: opts.daemon() === 'up' ? 'running' : 'absent' }) };
      }
      if (url === '/api/setup/ollama/start') {
        return { ok: true, status: 200, json: async () => ({ state: 'running' }) };
      }
      if (url === '/api/setup/models/pulls') {
        // Once a pull has started against a live daemon, the job lands instantly in this stub.
        const jobs = pullStarted && opts.daemon() === 'up'
          ? { [first.id]: { status: 'success', percent: null, error: null, done: true } } : {};
        return { ok: true, status: 200, json: async () => jobs };
      }
      // The pull start: accepted once the daemon is up, otherwise the tagged connection failure.
      if (opts.daemon() === 'up') {
        pullStarted = true;
        return { ok: true, status: 202, json: async () => ({ started: true }) };
      }
      return {
        ok: false,
        status: 502,
        json: async () => ({
          error: "Ollama isn't installed yet — install it, and this download will start on its own.",
          reason: opts.reason,
          ollama: { install: opts.install ?? { platform: 'linux', url: 'https://ollama.com/download/linux', command: 'curl -fsSL https://ollama.com/install.sh | sh' } },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, calls };
  }

  it('offers an install path instead of an error when Ollama is absent', async () => {
    const onConfigured = vi.fn();
    stubOllama({ reason: 'not-installed', daemon: () => 'down' });
    render(<LocalModelGetter installed={[]} onConfigured={onConfigured} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Get' })[0]);

    // A link they can act on, and the platform's one-liner — not a dead error string.
    const link = await screen.findByRole('link', { name: 'Install Ollama' });
    expect(link.getAttribute('href')).toBe('https://ollama.com/download/linux');
    expect(screen.getByText(/curl -fsSL/)).toBeTruthy();
    // It is a next step, not a failure: nothing renders in the alert role.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onConfigured).not.toHaveBeenCalled();
  });

  it('resumes the download by itself once Ollama appears', async () => {
    vi.useFakeTimers();
    try {
      const onConfigured = vi.fn();
      let daemon: 'up' | 'down' = 'down';
      stubOllama({ reason: 'not-installed', daemon: () => daemon });
      render(<LocalModelGetter installed={[]} onConfigured={onConfigured} />);
      fireEvent.click(screen.getAllByRole('button', { name: 'Get' })[0]);
      await vi.waitFor(() => expect(screen.queryByText(/Install Ollama/)).toBeTruthy());

      // The learner runs the installer in another window. We should notice without being asked.
      daemon = 'up';
      await vi.advanceTimersByTimeAsync(2500);
      await vi.waitFor(() => expect(onConfigured).toHaveBeenCalledWith(first.id));
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers to start an installed-but-stopped daemon, then finishes the pull', async () => {
    const onConfigured = vi.fn();
    let daemon: 'up' | 'down' = 'down';
    const { calls } = stubOllama({ reason: 'not-running', daemon: () => daemon });
    render(<LocalModelGetter installed={[]} onConfigured={onConfigured} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Get' })[0]);

    const start = await screen.findByRole('button', { name: 'Start Ollama' });
    // Nobody with Ollama already on disk should be pointed at a download page.
    expect(screen.queryByRole('link', { name: 'Install Ollama' })).toBeNull();

    daemon = 'up';
    fireEvent.click(start);
    await waitFor(() => expect(onConfigured).toHaveBeenCalledWith(first.id));
    expect(calls).toContain('/api/setup/ollama/start');
  });
});
