import { useRef, useState } from 'react';
import { RECOMMENDED_LOCAL_MODELS } from '../../shared/localModels.js';
import { pullOllamaModel, type PullProgress } from '../lib/pullModel.js';

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
  const abortRef = useRef<AbortController | null>(null);

  const get = async (id: string) => {
    setPulling(id);
    setError(null);
    setProgress({ status: 'starting…', percent: null });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await pullOllamaModel(id, setProgress, { signal: ctrl.signal });
      await onConfigured(id);
    } catch (e: any) {
      if (!ctrl.signal.aborted) setError(e?.message ?? String(e));
    } finally {
      setPulling(null);
      abortRef.current = null;
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
      {error && <p className="local-getter-error" role="alert">{error}</p>}
    </div>
  );
}
