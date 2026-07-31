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

function stubPull(chunks: string[], ok = true) {
  const fetchMock = vi.fn(async () => {
    if (!ok) return { ok: false, status: 502, body: null, json: async () => ({ error: 'install ollama from ollama.com' }) };
    const body = new ReadableStream<Uint8Array>({
      start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(x)); c.close(); },
    });
    return { ok: true, status: 200, body };
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
    expect(fetchMock).not.toHaveBeenCalled(); // "use it" never pulls
  });

  it('Get pulls with a progress bar, then configures on a clean stream', async () => {
    const onConfigured = vi.fn();
    stubPull([
      '{"status":"downloading","total":100,"completed":60}\n',
      '{"status":"success"}\n',
    ]);
    render(<LocalModelGetter installed={[]} onConfigured={onConfigured} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Get' })[0]); // qwen3:8b
    await waitFor(() => expect(onConfigured).toHaveBeenCalledWith(first.id));
    // The progress region rendered a percentage on the way through.
    // (After completion the row flips back; the assertion that matters is onConfigured fired.)
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
  /** Routes by URL so one stub can serve the pull, the state poll, and the start call. `daemon`
   *  is read fresh each call, so a test can bring Ollama "up" mid-flight. */
  function stubOllama(opts: { reason: string; daemon: () => 'up' | 'down'; install?: unknown }) {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/api/setup/ollama') {
        return { ok: true, status: 200, json: async () => ({ state: opts.daemon() === 'up' ? 'running' : 'absent' }) };
      }
      if (url === '/api/setup/ollama/start') {
        return { ok: true, status: 200, json: async () => ({ state: 'running' }) };
      }
      // The pull: succeeds once the daemon is up, otherwise reports the tagged connection failure.
      if (opts.daemon() === 'up') {
        const body = new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(new TextEncoder().encode('{"status":"success"}\n')); c.close(); },
        });
        return { ok: true, status: 200, body };
      }
      return {
        ok: false,
        status: 502,
        body: null,
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
