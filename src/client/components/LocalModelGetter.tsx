import { useEffect, useRef, useState } from 'react';
import { RECOMMENDED_LOCAL_MODELS } from '../../shared/localModels.js';
import {
  PullConnectionError, pullOllamaModel, type OllamaInstallHint, type PullFailureReason,
  type PullProgress,
} from '../lib/pullModel.js';

/** The pull couldn't connect, and we're now waiting on the learner to fix the one thing we can't:
 *  get Ollama onto their machine. `model` is remembered so the download resumes by itself. */
interface Blocked {
  model: string;
  reason: PullFailureReason;
  message: string;
  install?: OllamaInstallHint;
}

/** How often we re-ask whether Ollama has appeared. Two seconds is under the time it takes to
 *  notice a finished install, so the download looks like it started itself. */
const OLLAMA_POLL_MS = 2000;

/**
 * "Choose a model, we install it." The curated 7–9B list, each row either already installed (a
 * one-click "use it") or a "Get" button that pulls it through the proxy with a live progress bar,
 * then hands the id back for the caller to configure. Shared by the first-run card and the models
 * dialog so both offer the exact same on-ramp — the only difference is what onConfigured does
 * (first run: every role + lift the gate; dialog: the teaching-role preset).
 *
 * onConfigured fires for BOTH paths — a fresh pull and an already-installed "use it" — so the
 * caller has one place to point the roles at the chosen model. The pull is abortable: closing the
 * surface unmounts this and the in-flight fetch is cancelled by the AbortController.
 */
export function LocalModelGetter({
  installed, onConfigured, busy,
}: {
  /** Ollama tags already on disk (from discovery) — decides "use it" vs "Get". */
  installed: string[];
  /** Called with the ollama tag once it's ready to configure (pulled or already installed). */
  onConfigured: (id: string) => void | Promise<void>;
  /** The surface is doing something else (saving) — disable the buttons. */
  busy?: boolean;
}) {
  const [pulling, setPulling] = useState<string | null>(null);
  const [progress, setProgress] = useState<PullProgress>({ status: '', percent: null });
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [starting, setStarting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const get = async (id: string) => {
    setPulling(id);
    setError(null);
    setBlocked(null);
    setProgress({ status: 'starting…', percent: null });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await pullOllamaModel(id, setProgress, { signal: ctrl.signal });
      await onConfigured(id);
    } catch (e: any) {
      if (ctrl.signal.aborted) return;
      // A missing or stopped Ollama is not an error to report and abandon — it's a step we can walk
      // them through and then finish the download ourselves.
      if (e instanceof PullConnectionError) {
        setBlocked({ model: id, reason: e.reason, message: e.message, install: e.install });
      } else {
        setError(e?.message ?? String(e));
      }
    } finally {
      setPulling(null);
      abortRef.current = null;
    }
  };

  // While blocked on a missing Ollama, watch for it to appear and resume the download unprompted.
  // Someone who just finished an installer should not have to find their way back to this card and
  // remember which model they picked.
  useEffect(() => {
    if (!blocked || blocked.reason === 'unreachable') return undefined;
    let live = true;
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/setup/ollama');
        const now = await res.json() as { state?: string };
        if (live && now.state === 'running') {
          clearInterval(timer);
          void get(blocked.model);
        }
      } catch {
        // Still down, or the server blinked. The next tick asks again.
      }
    }, OLLAMA_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [blocked]);

  const startOllama = async () => {
    if (!blocked) return;
    setStarting(true);
    try {
      const res = await fetch('/api/setup/ollama/start', { method: 'POST' });
      if (res.ok) void get(blocked.model);
      else setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'could not start ollama');
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="local-getter">
      {RECOMMENDED_LOCAL_MODELS.map((m) => {
        const isInstalled = installed.includes(m.id);
        const isPulling = pulling === m.id;
        return (
          <div className="local-getter-row" key={m.id}>
            <div className="local-getter-info">
              <span className="local-getter-name">{m.label}</span>
              <span className="local-getter-note">
                {m.note}{isInstalled ? ' · installed' : ` · ${m.size} download`}
              </span>
            </div>
            {isPulling ? (
              <div className="local-getter-progress" role="status" aria-label={`downloading ${m.label}`}>
                {progress.percent === null
                  ? <span className="local-getter-status">{progress.status || 'working…'}</span>
                  : (
                    <>
                      <progress max={100} value={progress.percent} />
                      <span className="local-getter-status">{progress.percent}% · {progress.status}</span>
                    </>
                  )}
              </div>
            ) : (
              <button
                type="button"
                className={isInstalled ? 'local-getter-use' : 'local-getter-get'}
                disabled={busy || pulling !== null}
                onClick={() => (isInstalled ? void onConfigured(m.id) : void get(m.id))}
              >
                {isInstalled ? 'use it' : 'Get'}
              </button>
            )}
          </div>
        );
      })}
      {blocked && (
        <div className="local-getter-blocked" role="status">
          <p className="local-getter-blocked-lead">{blocked.message}</p>
          {blocked.reason === 'not-installed' && blocked.install && (
            <>
              <p className="local-getter-blocked-body">
                Ollama is a free, open-source runner — one install, and every model on this list
                works offline.
              </p>
              <div className="local-getter-blocked-actions">
                <a
                  className="local-getter-install"
                  href={blocked.install.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Install Ollama
                </a>
                {blocked.install.command && (
                  <code className="local-getter-command">{blocked.install.command}</code>
                )}
              </div>
              <p className="local-getter-blocked-foot">
                Leave this open — {blocked.model} starts downloading the moment it's ready.
              </p>
            </>
          )}
          {blocked.reason === 'not-running' && (
            <div className="local-getter-blocked-actions">
              <button type="button" className="local-getter-install" onClick={() => void startOllama()} disabled={starting}>
                {starting ? 'starting…' : 'Start Ollama'}
              </button>
            </div>
          )}
          {blocked.reason === 'unreachable' && (
            <div className="local-getter-blocked-actions">
              <button type="button" className="local-getter-install" onClick={() => void get(blocked.model)}>
                try again
              </button>
            </div>
          )}
        </div>
      )}
      {error && <p className="local-getter-error" role="alert">{error}</p>}
    </div>
  );
}
