// Client side of the "choose a model, we install it" flow. The download itself is a SERVER-owned
// background job (POST starts it, the server drains Ollama's stream detached from any request), so
// closing the dialog or navigating away costs nothing: this module only starts jobs and WATCHES
// them, polling GET /api/setup/models/pulls for progress. `activePulls` is how a freshly-mounted
// surface finds a download it (or a previous surface) started earlier and re-attaches.

/** Why a pull couldn't connect, straight from the proxy. The caller renders a different next step
 *  for each — install, start, or check the network — so this stays a tag, not prose. */
export type PullFailureReason = 'not-installed' | 'not-running' | 'unreachable';

export interface OllamaInstallHint {
  platform: 'macos' | 'windows' | 'linux';
  url: string;
  command?: string;
}

/** A connection failure that the UI can act on, rather than a string it can only print. */
export class PullConnectionError extends Error {
  constructor(
    message: string,
    readonly reason: PullFailureReason,
    readonly install?: OllamaInstallHint,
  ) {
    super(message);
    this.name = 'PullConnectionError';
  }
}

export interface PullProgress {
  /** Ollama's phase text, e.g. 'pulling manifest', 'downloading', 'verifying sha256', 'success'. */
  status: string;
  /** 0–100 when the current layer reports total/completed bytes; null for phases without a size
   * (manifest, verify) — the caller shows an indeterminate state then. */
  percent: number | null;
}

/** The server's job snapshot (setupRoutes.ts PullJob). */
export interface PullJobState extends PullProgress {
  error: string | null;
  done: boolean;
}

interface WatchOpts {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Poll cadence. The first read is immediate, so a finished job resolves without waiting. */
  pollMs?: number;
}

/** Every pull the server knows about, finished ones included. Empty on any failure — a surface
 *  that cannot ask simply shows no bars, which is the truthful degraded state. */
export async function activePulls(fetchImpl: typeof fetch = fetch): Promise<Record<string, PullJobState>> {
  try {
    const res = await fetchImpl('/api/setup/models/pulls');
    if (!res.ok) return {};
    return await res.json() as Record<string, PullJobState>;
  } catch {
    return {};
  }
}

/** Watch a running job to completion. Resolves when the job reports done; rejects on the job's
 *  own error. An aborted signal stops the WATCHING only — the server keeps downloading — and
 *  resolves quietly, because an unmounted surface has nobody left to tell. */
export async function watchPull(
  model: string,
  onProgress: (p: PullProgress) => void,
  opts: WatchOpts = {},
): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const pollMs = opts.pollMs ?? 1000;
  for (;;) {
    if (opts.signal?.aborted) return;
    const jobs = await activePulls(doFetch);
    const job = jobs[model];
    if (job) {
      if (job.error) throw new Error(job.error);
      onProgress({ status: job.status ?? '', percent: job.percent ?? null });
      if (job.done) return;
    }
    await new Promise((r) => { setTimeout(r, pollMs); });
  }
}

/** Start (or attach to — the server dedupes per model) a background pull, then watch it down.
 *  Resolves when the model is on disk, so a caller can `await` and then configure the roles. */
export async function pullOllamaModel(
  model: string,
  onProgress: (p: PullProgress) => void,
  opts: WatchOpts = {},
): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch('/api/setup/models/pull', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as {
      error?: string; reason?: PullFailureReason; ollama?: { install?: OllamaInstallHint };
    };
    const message = err.error ?? `pull failed (HTTP ${res.status})`;
    // A connection failure is recoverable and the UI has a specific offer for each kind; anything
    // else (a bad model name, a 400) is just a message.
    if (err.reason) throw new PullConnectionError(message, err.reason, err.ollama?.install);
    throw new Error(message);
  }
  await watchPull(model, onProgress, opts);
}
