import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { Hono } from 'hono';
import { configSource, type HarnessConfig } from './config.js';
import {
  applyCredentials, credentialsPath, looksLikeAnthropicKey, readCredentials, writeCredentials,
} from './credentials.js';

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

/** Model ids that need an Anthropic API key: a plain id routes through the Anthropic API, while
 *  `ollama:` is local. */
export function needsApiKey(cfg: HarnessConfig): string[] {
  return Object.entries(cfg.models)
    .filter(([, r]) => !r.model.startsWith('ollama:'))
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
  // Injectable seam for tests: the real probe hits api.anthropic.com, which does not belong in a
  // unit test of ROUTE behavior.
  deps: { probeFetch?: typeof fetch } = {},
) {
  const app = new Hono();

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

  return app;
}
