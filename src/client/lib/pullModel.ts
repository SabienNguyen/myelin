// Client side of the "choose a model, we install it" flow: POST the model to the pull proxy and
// read Ollama's newline-delimited JSON progress back, calling onProgress per line. Resolves when
// the stream ends clean, rejects on a terminal {error} line or a transport failure — so a caller
// can `await pullOllamaModel(...)` and then configure the roles, sure the model is on disk.

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

export async function pullOllamaModel(
  model: string,
  onProgress: (p: PullProgress) => void,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch('/api/setup/models/pull', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    // The proxy reports Ollama-unreachable and bad-request as JSON, not a stream.
    const err = await res.json().catch(() => ({})) as {
      error?: string; reason?: PullFailureReason; ollama?: { install?: OllamaInstallHint };
    };
    const message = err.error ?? `pull failed (HTTP ${res.status})`;
    // A connection failure is recoverable and the UI has a specific offer for each kind; anything
    // else (a bad model name, a 400) is just a message.
    if (err.reason) throw new PullConnectionError(message, err.reason, err.ollama?.install);
    throw new Error(message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // NDJSON: one JSON object per line. A partial trailing line stays in buf for the next chunk.
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: { status?: string; error?: string; total?: number; completed?: number };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a malformed fragment is skipped, not fatal — the next line resyncs
      }
      // Ollama reports a failed pull as a mid-stream {error} line (bad model name, disk full).
      if (msg.error) throw new Error(msg.error);
      const percent = typeof msg.total === 'number' && msg.total > 0
        ? Math.min(100, Math.round(((msg.completed ?? 0) / msg.total) * 100))
        : null;
      onProgress({ status: msg.status ?? '', percent });
    }
  }
}
