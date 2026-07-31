import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { Hono } from 'hono';
import { configSource, removedRouteMessage, type HarnessConfig, type ModelRole } from './config.js';
import {
  applyCredentials, credentialsPath, looksLikeAnthropicKey, readCredentials, writeCredentials,
} from './credentials.js';
import { classifyConnectionError, detectOllama, type OllamaState } from './ollamaState.js';
import {
  applyEnvValues, envShadow, PROVIDER_ENV_KEYS, readSettings, settingsPath, writeSettings,
  type ProviderEnvKey,
} from './settings.js';

/** A path as a person would say it. The absolute form of a vault path is four lines of monospace on
 *  a first-run card and nobody reads it; `~/Documents/Myelin` is the same information in six
 *  words. Shortening happens server-side because only the server knows the real home directory. */
export function displayPath(path: string, home = homedir()): string {
  if (!home) return path;
  if (path === home) return '~';
  // The separator check is the whole correctness of this: a bare startsWith turned
  // '/home/sabienne/vault' into '~ne/vault' when home was '/home/sabien' — a different directory,
  // rendered as if it were inside the user's own. Caught by the test, not by looking at it.
  const sep = path[home.length];
  return path.startsWith(home) && (sep === '/' || sep === '\\') ? `~${path.slice(home.length)}` : path;
}

/** What to say for each way a pull can fail to connect. Split out from the route so the wording is
 *  testable and so it stays obvious that the three cases really do say different things. */
export function pullFailureMessage(
  reason: 'not-installed' | 'not-running' | 'unreachable', model: string, root: string,
): string {
  if (reason === 'not-installed') {
    return `Ollama isn't installed yet — it's the local model runner that "${model}" downloads into. `
      + `Install it, and this download will start on its own.`;
  }
  if (reason === 'not-running') {
    return `Ollama is installed but isn't running, so "${model}" has nowhere to download to. `
      + `Start it and this will pick up where it left off.`;
  }
  return `Couldn't reach Ollama at ${root} to pull "${model}", though something is listening there. `
    + `A firewall or proxy between us is the usual cause.`;
}

/** Launch a detached `ollama serve` that outlives this request and survives the app quitting, with
 *  its pipes released — an inherited stdio pipe nobody drains is a hang waiting to happen. */
function spawnOllamaServe(binary: string): void {
  const child = spawn(binary, ['serve'], { detached: true, stdio: 'ignore' });
  child.unref();
}

/** One background model download. Kept — final state included — for the life of the process, so a
 *  poller that misses the last tick still reads `done`, and a reopened surface finds the download
 *  it started. */
export interface PullJob {
  status: string;
  percent: number | null;
  error: string | null;
  done: boolean;
}

/** Drain Ollama's NDJSON pull stream into the job — detached from any request, because the
 *  download this tracks is measured in gigabytes and the surfaces that watch it come and go. */
async function consumePull(model: string, job: PullJob, stream: AsyncIterable<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { status?: string; error?: string; total?: number; completed?: number };
        try { msg = JSON.parse(line); } catch { continue; } // a malformed fragment resyncs next line
        // Ollama reports a failed pull as a mid-stream {error} line (bad model name, disk full).
        if (msg.error) { job.error = msg.error; job.done = true; return; }
        job.status = msg.status ?? job.status;
        job.percent = typeof msg.total === 'number' && msg.total > 0
          ? Math.min(100, Math.round(((msg.completed ?? 0) / msg.total) * 100))
          : null;
      }
    }
    job.done = true;
  } catch (e) {
    job.error = e instanceof Error ? e.message : String(e);
    job.done = true;
    console.error(`[model pull ${model}]`, job.error);
  }
}

/** Model ids that need an Anthropic API key: only a plain id routes through the Anthropic API.
 *  `ollama:` is local and `openai:` rides OPENAI_COMPAT_BASE_URL with its own (optional) key —
 *  a setup running every role on a compat endpoint must not be walled at first run demanding an
 *  Anthropic key it will never use. (Found live: an all-openai: config booted into the key gate.) */
export function needsApiKey(cfg: HarnessConfig): string[] {
  return Object.entries(cfg.models)
    .filter(([, r]) => !r.model.startsWith('ollama:') && !r.model.startsWith('openai:'))
    .map(([role]) => role);
}

/**
 * First-run state, and the one thing a first run can fix from inside the app.
 *
 * Everything else about setup now has a working default (see config.ts), which leaves exactly one
 * question a new user must answer and no defaulting can invent: an Anthropic API key for every
 * role that is not routed to a local model.
 *
 * `blocked` is the question the client actually needs answered: can a lesson happen right now? It is
 * deliberately narrower than "is anything imperfect" — a missing Ollama or a missing gap sidecar
 * costs a feature, while missing authorisation costs everything.
 */
export function buildSetupRoutes(
  cfg: HarnessConfig,
  // Injectable seam for tests: the real probes hit api.anthropic.com and the provider endpoints,
  // none of which belongs in a unit test of ROUTE behavior.
  deps: { probeFetch?: typeof fetch; detect?: typeof detectOllama; startOllama?: (binary: string) => void } = {},
) {
  const app = new Hono();
  const pulls = new Map<string, PullJob>();

  const state = () => {
    const roles = needsApiKey(cfg);
    const fromEnv = Boolean(process.env.ANTHROPIC_API_KEY);
    const saved = Boolean(readCredentials().anthropicApiKey);
    // A fully `ollama:` config needs no key. A scripted model (LW_MOCK_MODEL, the e2e hook) needs
    // no authorisation at all — every model call is intercepted before any provider is reached.
    // Without this the first-run gate blocked the whole e2e suite at "Ready when you are", a
    // screen no scripted run can click through.
    const authorised = roles.length === 0 || fromEnv || saved || Boolean(process.env.LW_MOCK_MODEL);
    return {
      apiKey: {
        // Which roles would break without a key, so the message can be specific: "the tutor needs
        // one" is actionable where "a key is missing" is not.
        rolesNeeding: roles,
        present: fromEnv || saved,
        source: fromEnv ? 'environment' : saved ? 'saved' : null,
        // Named so a user who prefers to manage secrets themselves knows where to look.
        savedAt: displayPath(credentialsPath()),
      },
      vault: { path: displayPath(cfg.vault), exists: existsSync(cfg.vault) },
      config: configSource(),
      blocked: !authorised,
    };
  };

  app.get('/api/setup', (c) => c.json(state()));

  app.put('/api/setup/api-key', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const key = String(body?.key ?? '').trim();
    if (!key) return c.json({ error: 'Paste your key first.' }, 400);
    if (!looksLikeAnthropicKey(key)) {
      // Two different failures deserve two different sentences: the audit pasted a key that DID
      // start with sk-ant- and was told it didn't — the real problem was length, and a user whose
      // paste truncated can SEE the prefix is right, so the old copy read as the app being wrong.
      return c.json({
        error: key.startsWith('sk-ant-')
          ? 'That key looks truncated — Anthropic keys are much longer. Paste the whole key.'
          : 'That does not look like an Anthropic key — they start with “sk-ant-”.',
      }, 400);
    }

    // Probe before saving. A wrong key that gets stored looks exactly like a working one until the
    // first lesson fails, and at that point the error surfaces as a lost turn rather than as
    // "your key is wrong" — which is the single worst place to learn it.
    const probe = await (deps.probeFetch ?? fetch)('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15_000),
    }).catch((e: any) => ({ ok: false, status: 0, statusText: String(e?.message ?? e) } as Response));

    if (!probe.ok) {
      const why = probe.status === 401 || probe.status === 403
        ? 'Anthropic rejected that key.'
        : probe.status === 0
          ? `Could not reach Anthropic to check the key (${probe.statusText}).`
          : `Anthropic answered ${probe.status} when checking the key.`;
      return c.json({ error: why }, 400);
    }

    writeCredentials({ ...readCredentials(), anthropicApiKey: key });
    // Straight into the environment, so the very next turn works without a restart.
    process.env.ANTHROPIC_API_KEY = key;
    applyCredentials();
    return c.json(state());
  });

  const roleNames = () => Object.keys(cfg.models) as ModelRole[];

  // What the models popover renders. The two API keys are write-only: a saved key comes back as
  // `set: true`, never as its value — the same rule the Anthropic key flow follows. Base URLs are
  // not secrets, so their saved values do come back.
  const modelsState = () => {
    const saved = readSettings();
    const shadow = envShadow();
    return {
      roles: Object.fromEntries(roleNames().map((r) => [r, {
        effective: cfg.models[r].model,
        saved: saved.models?.[r] ?? null,
      }])),
      // The live value, not the saved one — harness.config.json can set it too, and the checkbox
      // should show what the next turn will actually do.
      tutorRails: Boolean(cfg.models.tutor.rails),
      env: {
        OLLAMA_BASE_URL: { value: saved.env?.OLLAMA_BASE_URL ?? '', shadowed: shadow.OLLAMA_BASE_URL },
        OLLAMA_API_KEY: { set: Boolean(saved.env?.OLLAMA_API_KEY), shadowed: shadow.OLLAMA_API_KEY },
        OPENAI_COMPAT_BASE_URL: {
          value: saved.env?.OPENAI_COMPAT_BASE_URL ?? '', shadowed: shadow.OPENAI_COMPAT_BASE_URL,
        },
        OPENAI_COMPAT_API_KEY: {
          set: Boolean(saved.env?.OPENAI_COMPAT_API_KEY), shadowed: shadow.OPENAI_COMPAT_API_KEY,
        },
      },
      savedAt: displayPath(settingsPath()),
    };
  };

  /** What the endpoints report as installed/served right now, so the dialog can offer real ids
   *  instead of asking anyone to type one from memory. Each probe is short (the dialog fetches on
   *  open and must open instantly offline), a failed probe leaves its field absent, and nothing is
   *  cached across requests — a model pulled a minute ago should appear on the next open. */
  const DISCOVERY_TIMEOUT_MS = 1500;
  // Ollama's native API (tags, pull) lives at the server ROOT, not under the /v1 compat prefix the
  // chat routes use — strip a trailing /v1 so one env var configures both.
  const ollamaRoot = () => (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1')
    .replace(/\/$/, '').replace(/\/v1$/, '');
  const discoverModels = async (): Promise<{ ollama?: string[]; openaiCompat?: string[] }> => {
    const f = deps.probeFetch ?? fetch;
    const probe = async (url: string, headers?: Record<string, string>): Promise<unknown> => {
      const res = await f(url, { headers, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`discovery probe: HTTP ${res.status} from ${url}`);
      return res.json();
    };
    const compatBase = process.env.OPENAI_COMPAT_BASE_URL?.replace(/\/$/, '');
    const compatKey = process.env.OPENAI_COMPAT_API_KEY;
    const [tags, ids] = await Promise.allSettled([
      probe(`${ollamaRoot()}/api/tags`),
      // No base URL means no endpoint to ask — not a failed probe worth 1500ms.
      compatBase
        ? probe(`${compatBase}/models`, compatKey ? { authorization: `Bearer ${compatKey}` } : undefined)
        : Promise.reject(new Error('OPENAI_COMPAT_BASE_URL unset')),
    ]);
    const strings = (values: unknown[]): string[] =>
      values.filter((v): v is string => typeof v === 'string' && v.length > 0);
    const available: { ollama?: string[]; openaiCompat?: string[] } = {};
    if (tags.status === 'fulfilled') {
      const models = (tags.value as { models?: { name?: unknown }[] })?.models;
      const names = strings((Array.isArray(models) ? models : []).map((m) => m?.name));
      if (names.length) available.ollama = names;
    }
    if (ids.status === 'fulfilled') {
      const data = (ids.value as { data?: { id?: unknown }[] })?.data;
      const names = strings((Array.isArray(data) ? data : []).map((m) => m?.id));
      if (names.length) available.openaiCompat = names;
    }
    return available;
  };

  app.get('/api/setup/models', async (c) => c.json({ ...modelsState(), available: await discoverModels() }));

  const detect = (): Promise<OllamaState> =>
    (deps.detect ?? detectOllama)(ollamaRoot(), { fetchImpl: deps.probeFetch });

  /** Which of the three Ollama situations the learner is in. The first-run card fetches this before
   *  offering a model so it can show an install path instead of a dead "Get" button, and polls it
   *  after sending someone to ollama.com so the pull resumes on its own the moment the daemon
   *  appears. Never fails: "we could not tell" is still an answer the UI can render. */
  app.get('/api/setup/ollama', async (c) => c.json(await detect()));

  /** Start a daemon that is installed but down, so "not running" costs a click instead of a trip to
   *  a terminal. Only ever spawns a binary WE located on disk — never a name off the request. */
  app.post('/api/setup/ollama/start', async (c) => {
    const found = await detect();
    if (found.state === 'running') return c.json(found);
    if (found.state === 'absent') return c.json({ error: 'ollama is not installed', ...found }, 409);
    try {
      (deps.startOllama ?? spawnOllamaServe)(found.binary);
    } catch (e) {
      return c.json({ error: `couldn't start ollama: ${(e as Error).message}`, ...found }, 502);
    }
    // The daemon takes a moment to bind. Poll rather than making the client guess a sleep.
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      const now = await detect();
      if (now.state === 'running') return c.json(now);
    }
    return c.json({ error: 'started ollama but it did not come up in 5s', ...found }, 504);
  });

  /** Pull an Ollama model on the learner's behalf: the "choose a model, we install it" path. Proxies
   *  Ollama's streaming POST /api/pull and relays its newline-delimited JSON progress straight
   *  through — the client renders a progress bar from each line's {status,total,completed} and
   *  configures the roles once the stream ends clean. No timeout here (a model is gigabytes and the
   *  download runs for minutes); the request's own signal aborts the upstream pull if the learner
   *  navigates away.
   *
   *  A failed connection carries a `reason` tag, because the three ways this fails need three
   *  different things from the learner and one sentence cannot serve all of them: install Ollama,
   *  start Ollama, or look at their network. Telling someone who has it installed to go install it
   *  is how this flow earned "doesn't work". */
  app.post('/api/setup/models/pull', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const model = String((body as { model?: unknown })?.model ?? '').trim();
    if (!model) return c.json({ error: 'pull requires a "model" name, e.g. "qwen3:8b"' }, 400);
    // One download per model, however many watchers: a reopened dialog POSTs again and must find
    // the running job, not start a second multi-gigabyte pull. A finished job (done or failed)
    // does not block a retry — it is replaced below.
    const existing = pulls.get(model);
    if (existing && !existing.done) return c.json({ started: false, job: existing }, 200);
    const f = deps.probeFetch ?? fetch;
    const root = ollamaRoot();
    let upstream: Response;
    try {
      // Deliberately NOT tied to this request's signal: the job must outlive the surface that
      // started it — a learner who closes the dialog mid-download keeps their gigabytes.
      upstream = await f(`${root}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true }),
      });
    } catch (err) {
      const found = await detect();
      const reason = classifyConnectionError(err, found);
      return c.json({ error: pullFailureMessage(reason, model, root), reason, ollama: found }, 502);
    }
    if (!upstream.ok || !upstream.body) {
      return c.json({ error: `Ollama refused the pull of "${model}" (HTTP ${upstream.status})` }, 502);
    }
    const job: PullJob = { status: 'starting', percent: null, error: null, done: false };
    pulls.set(model, job);
    void consumePull(model, job, upstream.body);
    return c.json({ started: true, job }, 202);
  });

  /** Progress snapshots for every pull this process has run — the poll target for progress bars,
   *  and how a reopened surface finds a download it started earlier. */
  app.get('/api/setup/models/pulls', (c) => c.json(Object.fromEntries(pulls)));

  app.put('/api/setup/models', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const models = Object.entries((body?.models ?? {}) as Record<string, unknown>);
    const env = (body?.env ?? {}) as Record<string, unknown>;
    const tutorRails = body?.tutorRails as unknown;
    if (tutorRails !== undefined && typeof tutorRails !== 'boolean') {
      return c.json({ error: 'tutorRails must be a boolean' }, 400);
    }

    for (const [role, id] of models) {
      if (!roleNames().includes(role as ModelRole)) {
        return c.json({ error: `unknown model role: "${role}" — roles are ${roleNames().join(', ')}` }, 400);
      }
      if (typeof id !== 'string' || !id.trim()) {
        return c.json({ error: `model for ${role} is empty — give it a model id or leave the role out` }, 400);
      }
    }
    for (const key of Object.keys(env)) {
      if (!(PROVIDER_ENV_KEYS as readonly string[]).includes(key)) {
        return c.json({ error: `unknown env field: "${key}" — fields are ${PROVIDER_ENV_KEYS.join(', ')}` }, 400);
      }
    }
    const ids = models as [string, string][];
    const removed = ids.filter(([, id]) => id.trim().startsWith('claude-sdk:'))
      .map(([role, id]) => `${role}: "${id}"`);
    if (removed.length) return c.json({ error: removedRouteMessage(removed, 'this request') }, 400);
    // An openai: role with no base URL anywhere would fail mid-lesson (models.ts throws at call
    // time); refuse the save here instead, where the fix is the field right below.
    const openaiRole = ids.find(([, id]) => id.trim().startsWith('openai:'));
    const baseUrl = String(env.OPENAI_COMPAT_BASE_URL ?? '').trim()
      || process.env.OPENAI_COMPAT_BASE_URL;
    if (openaiRole && !baseUrl) {
      return c.json({
        error: `model "${openaiRole[1].trim()}" needs an OpenAI-compatible base URL — fill it in `
          + `below (e.g. https://openrouter.ai/api/v1) or set OPENAI_COMPAT_BASE_URL`,
      }, 400);
    }

    // Persist: merge over what is already saved, so a request that only touches one role or one
    // endpoint leaves the rest of settings.json alone.
    const saved = readSettings();
    const nextModels = { ...saved.models };
    for (const [role, id] of ids) nextModels[role as ModelRole] = id.trim();
    const nextEnv = { ...saved.env };
    for (const k of PROVIDER_ENV_KEYS) {
      const v = env[k];
      if (typeof v === 'string' && v.trim()) nextEnv[k] = v.trim();
    }
    writeSettings({
      ...saved, models: nextModels, env: nextEnv,
      ...(tutorRails !== undefined ? { tutorRails } : {}),
    });

    // Live, no restart: cfg.models is the object every route and chatModelFor call reads, and
    // models.ts resolves the provider env per call.
    for (const [role, id] of ids) cfg.models[role as ModelRole].model = id.trim();
    if (tutorRails !== undefined) cfg.models.tutor.rails = tutorRails;
    applyEnvValues(nextEnv as Partial<Record<ProviderEnvKey, string>>);
    return c.json(modelsState());
  });

  return app;
}
