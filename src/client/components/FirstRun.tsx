import { useEffect, useState } from 'react';
import { BookOpenTextIcon as BookOpenText, KeyIcon as Key, CpuIcon as Cpu } from '@phosphor-icons/react';
import { LocalModelGetter } from './LocalModelGetter.js';

interface SetupState {
  apiKey: { rolesNeeding: string[]; present: boolean; source: string | null; savedAt: string };
  vault: { path: string; exists: boolean };
  config: { path: string; found: boolean };
  blocked: boolean;
}

/**
 * The whole of first-run setup.
 *
 * Every other setting has a default that works (config.ts), which leaves exactly one question a
 * new user must answer: how the model roles reach A model. Two ways through: an Anthropic API key
 * for the default claude-* roles, or pointing every role at a local/OpenAI-compatible model —
 * both paths live on this card, because "Anthropic key or nothing" walled out exactly the local-
 * model users the harness now serves. (A config already routed fully local never reaches this
 * card — `blocked` stays false.)
 *
 * A gate, not a dismissible banner. A banner would let someone type a question to a tutor that
 * cannot answer, and the failure would arrive as a lost turn several seconds later.
 */
/** The split the Anthropic card saves: Sonnet where the learner reads the prose, Haiku for the
 *  mechanical roles. Not Opus — the tutor runs every turn, and spending that is the user's call. */
const CLAUDE_ROLES = {
  tutor: 'claude-sonnet-5', grader: 'claude-haiku-4-5', quiz_gen: 'claude-sonnet-5',
  card_gen: 'claude-haiku-4-5', compile: 'claude-sonnet-5',
};

/** What the OpenAI card points every role at: the oai: route (OpenAI's own Responses API, with
 *  its built-in web search), on the model the maintainer runs day to day. */
const OPENAI_MODEL = 'oai:gpt-6-luna';

export function FirstRun({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SetupState | null>(null);
  const [key, setKey] = useState('');
  const [localId, setLocalId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [compatKey, setCompatKey] = useState('');
  const [routerKey, setRouterKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/setup')
      .then((r) => r.json())
      .then(setState)
      // A setup check that itself fails must not black out the app: fall through and let the real
      // failure surface where it happens.
      .catch(() => setState(null));
  }, []);

  // Ollama tags already on disk. Discovery is keyless — the gate blocks model CALLS, not the tag
  // probe — and without it the on-ramp offered a multi-GB "Get" for a model the person already
  // had. Best-effort: on failure every row just says Get, and a Get of an installed tag is a
  // fast verify, not a re-download.
  const [installedLocal, setInstalledLocal] = useState<string[]>([]);
  useEffect(() => {
    fetch('/api/setup/models')
      .then((r) => r.json())
      .then((d) => setInstalledLocal((d?.available?.ollama ?? []) as string[]))
      .catch(() => {});
  }, []);

  async function saveKey() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/setup/api-key', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'That did not work.'); return; }
      // The key alone satisfies nothing: every role defaults to OpenRouter, so the gate would stay
      // up with no message. Picking this card means "run on Claude".
      await saveRoles(CLAUDE_ROLES);
    } catch (err: any) {
      setError(`Could not reach the app’s own server (${err?.message ?? err}).`);
    } finally {
      setBusy(false);
    }
  }

  /** The keyless path: every role onto one local/compat model id. All five roles on purpose —
   * with no Anthropic key there is nothing stronger to keep compile on, and the models dialog
   * can split the roles later. Saved through the same endpoint the dialog uses, then /api/setup
   * is re-read: with no role on the Anthropic route, `blocked` comes back false and the gate
   * lifts itself. */
  function saveAllRolesTo(id: string, opts: { env?: Record<string, string> } = {}) {
    return saveRoles({ tutor: id, grader: id, quiz_gen: id, card_gen: id, compile: id }, opts);
  }

  async function saveRoles(models: Record<string, string>, opts: { env?: Record<string, string> } = {}) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/setup/models', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          models,
          ...(opts.env && Object.keys(opts.env).length ? { env: opts.env } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as any).error ?? 'That did not work.');
        return;
      }
      const fresh = await (await fetch('/api/setup')).json();
      setState(fresh);
      // A 200 here only means the save landed, not that the id resolves — a typo'd tag or an
      // unreachable host still leaves the Anthropic-only roles without a model. Without this check
      // the card just re-rendered itself with the same inputs and no explanation for why the gate
      // hadn't lifted.
      if (fresh?.blocked) {
        const roles = fresh.apiKey?.rolesNeeding?.length ? fresh.apiKey.rolesNeeding.join(', ') : 'some roles';
        setError(`Saved, but ${roles} still can’t reach a model — check the id and try again.`);
      }
    } catch (err: any) {
      setError(`Could not reach the app’s own server (${err?.message ?? err}).`);
    } finally {
      setBusy(false);
    }
  }

  function saveLocal() {
    const env: Record<string, string> = {};
    if (baseUrl.trim()) env.OPENAI_COMPAT_BASE_URL = baseUrl.trim();
    if (compatKey.trim()) env.OPENAI_COMPAT_API_KEY = compatKey.trim();
    return saveAllRolesTo(localId.trim(), { env });
  }

  if (!state?.blocked) return <>{children}</>;

  // Only an `openai:` id reaches a remote OpenAI-compatible endpoint and needs a base URL (plus
  // maybe a key). A bare id like "deepseek/deepseek-chat" is NOT that — per models.ts's
  // modelRouteFor, anything without `ollama:` or `openai:` routes through the Anthropic API, so
  // revealing the compat fields for it would be wrong, not just unlabeled: the id would save,
  // route to Anthropic, and the base URL the learner typed would go nowhere. Fixed at the copy
  // layer instead — the note below says explicitly to prefix a remote endpoint with `openai:`.
  const wantsCompat = localId.trim().startsWith('openai:');

  return (
    <div className="firstrun">
      {/* main, not div: this screen replaces the whole app, so it needs its own main landmark —
          axe landmark-one-main/region, caught scanning the setup states. */}
      <main className="firstrun-card">
        <p className="firstrun-mark"><BookOpenText size={18} weight="duotone" /> Myelin</p>
        <h1>Ready when you are</h1>
        {/* Written for someone who has never made an API key. The free OpenRouter path is the only
            one on the face of the card; the Claude and local-model paths sit behind "other ways",
            because a first-time visitor shown three equal options with "OpenAI-compatible" and
            "prefix the id" in them stopped reading at the second. */}
        <p className="firstrun-lede">
          Myelin needs an AI model to teach you. The free way takes about two minutes:
        </p>

        <form className="firstrun-option" onSubmit={(e) => {
          e.preventDefault();
          void saveAllRolesTo('openrouter:openrouter/free', {
            env: routerKey.trim() ? { OPENROUTER_API_KEY: routerKey.trim() } : {},
          });
        }}>
          <ol className="firstrun-steps">
            <li>
              <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">
                Open openrouter.ai
              </a>
              {' '}and sign in. It is free; no card needed.
            </li>
            <li>Create a key (any name will do) and copy it.</li>
            <li>Paste it below.</li>
          </ol>
          <label htmlFor="router-key">OpenRouter API key</label>
          <div className="firstrun-row">
            <input id="router-key" type="password" autoFocus autoComplete="off" spellCheck={false}
              placeholder="sk-or-…" value={routerKey}
              onChange={(e) => setRouterKey(e.target.value)} />
            <button type="submit" className="firstrun-primary" disabled={busy || !routerKey.trim()}>
              {busy ? 'Checking…' : 'Use free models'}
            </button>
          </div>
          <p className="firstrun-note">
            The key is checked with OpenRouter before it is saved, and stays on this computer. Your
            lessons go to OpenRouter’s free models, which can be slow when they are busy.
          </p>
        </form>

        <details className="firstrun-more">
          <summary>Other ways to connect: Claude, OpenAI, or a model on this computer</summary>
          <form
            className="firstrun-option"
            onSubmit={(e) => { e.preventDefault(); void saveKey(); }}
          >
            <label htmlFor="api-key">
              <Key size={16} weight="duotone" /> Anthropic API key
            </label>
            <div className="firstrun-row">
              <input
                id="api-key" type="password" autoComplete="off"
                spellCheck={false} placeholder="sk-ant-…"
                value={key} onChange={(e) => setKey(e.target.value)}
              />
              <button
                type="submit"
                className="firstrun-primary"
                disabled={busy || !key.trim()}
              >
                {busy ? 'Checking…' : 'Save'}
              </button>
            </div>
            {/* Its own line, not buried at the end of the reassurance paragraph. Someone who has
                not got a key yet is the most common first-run visitor, and in the first version this
                was the last four words of a dense grey block. */}
            <p className="firstrun-getkey">
              Don’t have one?{' '}
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                Create a key at console.anthropic.com
              </a>
            </p>
            <p className="firstrun-note">
              Checked with Anthropic before it is saved, so a wrong key fails here rather than mid-lesson.
            </p>
          </form>


          {/* Its own card rather than the openai: field below: that one needs a typed id and a
              base URL, which nobody arriving with "I have an OpenAI key" should have to know. */}
          <form
            className="firstrun-option"
            onSubmit={(e) => {
              e.preventDefault();
              void saveAllRolesTo(OPENAI_MODEL, { env: { OPENAI_API_KEY: openaiKey.trim() } });
            }}
          >
            <label htmlFor="openai-key">
              <Key size={16} weight="duotone" /> OpenAI API key
            </label>
            <div className="firstrun-row">
              <input
                id="openai-key" type="password" autoComplete="off"
                spellCheck={false} placeholder="sk-…"
                value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)}
              />
              <button type="submit" className="firstrun-primary" disabled={busy || !openaiKey.trim()}>
                {busy ? 'Checking…' : 'Use OpenAI'}
              </button>
            </div>
            <p className="firstrun-getkey">
              Don’t have one?{' '}
              <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
                Create a key at platform.openai.com
              </a>
            </p>
            <p className="firstrun-note">
              Paid: OpenAI bills your account for each lesson. The key is checked with OpenAI before
              it is saved.
            </p>
          </form>

          <form
            className="firstrun-option"
            onSubmit={(e) => { e.preventDefault(); void saveLocal(); }}
          >
            <label htmlFor="local-model">
              <Cpu size={16} weight="duotone" /> A local or OpenAI-compatible model
            </label>
            <div className="firstrun-row">
              <input
                id="local-model" type="text" autoComplete="off" spellCheck={false}
                placeholder="openai:gpt-4o-mini  ·  ollama:qwen3:8b"
                list="firstrun-model-ids"
                value={localId} onChange={(e) => setLocalId(e.target.value)}
              />
              <button type="submit" className="firstrun-primary" disabled={busy || !localId.trim()}>
                {busy ? 'Saving…' : 'Use it'}
              </button>
            </div>
            <datalist id="firstrun-model-ids">
              <option value="openai:gpt-4o-mini" />
              <option value="openai:deepseek/deepseek-chat" />
              <option value="ollama:qwen3:8b" />
              <option value="ollama:llama3.1:8b" />
            </datalist>
            {wantsCompat && (
              <>
                <p className="firstrun-note">where that model lives, and the key it needs:</p>
                <div className="firstrun-row">
                  <input
                    type="text" autoComplete="off" spellCheck={false} aria-label="OpenAI-compatible base URL"
                    placeholder="base URL, e.g. https://openrouter.ai/api/v1"
                    value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                  />
                  <input
                    type="password" autoComplete="off" spellCheck={false} aria-label="OpenAI-compatible API key"
                    placeholder="API key (if the endpoint needs one)"
                    value={compatKey} onChange={(e) => setCompatKey(e.target.value)}
                  />
                </div>
              </>
            )}
            <p className="firstrun-note">
              Points every role at it — <code>ollama:</code> needs Ollama running. Reaching OpenRouter,
              LM Studio, LiteLLM, or any other OpenAI-compatible host? Prefix the id with{' '}
              <code>openai:</code> and the base URL and key fields appear. Split the roles later from
              the model badge in the top bar.
            </p>
            {/* The zero-typing on-ramp: pick a recommended local model and we pull + configure it.
                A pulled model points every role at it, then re-reads /api/setup — with nothing on the
                Anthropic route the gate lifts itself. */}
            <p className="firstrun-getter-lede">Don’t have a model yet? Pick one and we’ll install it:</p>
            <LocalModelGetter
              installed={installedLocal}
              busy={busy}
              onConfigured={(id) => saveAllRolesTo(`ollama:${id}`)}
            />
          </form>
        </details>

        {error && <p className="firstrun-error" role="alert">{error}</p>}

        {/* Where things live, once. Answering "where are my notes" and "where does my key go" is
            worth doing and worth doing quietly. */}
        <p className="firstrun-note firstrun-paths">
          Notes: <code>{state.vault.path}</code>
          {/* The folder, not credentials.json: only the Anthropic key lands there; OpenRouter and
              OpenAI keys go to settings.json beside it. */}
          {' '}· Keys: <code>{state.apiKey.savedAt.replace(/[^/\\]+$/, '')}</code>, outside your notes
        </p>
      </main>
    </div>
  );
}
