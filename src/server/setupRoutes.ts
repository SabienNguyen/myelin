import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import { configSource, type HarnessConfig } from './config.js';
import {
  applyCredentials, credentialsPath, looksLikeAnthropicKey, readCredentials, writeCredentials,
} from './credentials.js';

/** Model ids that need an Anthropic API key: a plain id routes through the Anthropic API, while
 *  `ollama:` is local and `claude-sdk:` draws on the local `claude` CLI login instead. */
export function needsApiKey(cfg: HarnessConfig): string[] {
  return Object.entries(cfg.models)
    .filter(([, r]) => !r.model.startsWith('ollama:') && !r.model.startsWith('claude-sdk:'))
    .map(([role]) => role);
}

/**
 * First-run state, and the one thing a first run can fix from inside the app.
 *
 * Everything else about setup now has a working default (see config.ts), which leaves exactly one
 * thing a new user must supply and cannot be defaulted: the API key. So this is the whole of setup —
 * a readiness report the UI can act on, and a single place to put the key.
 *
 * `blocked` is the question the client actually needs answered: can a lesson happen right now? It is
 * deliberately narrower than "is anything imperfect" — a missing Ollama or a missing gap sidecar
 * costs a feature, while a missing key costs everything.
 */
export function buildSetupRoutes(cfg: HarnessConfig) {
  const app = new Hono();

  const state = () => {
    const roles = needsApiKey(cfg);
    const fromEnv = Boolean(process.env.ANTHROPIC_API_KEY);
    const saved = Boolean(readCredentials().anthropicApiKey);
    return {
      apiKey: {
        // Which roles would break without a key, so the message can be specific: "the tutor needs
        // one" is actionable where "a key is missing" is not.
        rolesNeeding: roles,
        present: fromEnv || saved,
        source: fromEnv ? 'environment' : saved ? 'saved' : null,
        // Named so a user who prefers to manage secrets themselves knows where to look.
        savedAt: credentialsPath(),
      },
      vault: { path: cfg.vault, exists: existsSync(cfg.vault) },
      config: configSource(),
      blocked: roles.length > 0 && !fromEnv && !saved,
    };
  };

  app.get('/api/setup', (c) => c.json(state()));

  app.put('/api/setup/api-key', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const key = String(body?.key ?? '').trim();
    if (!key) return c.json({ error: 'Paste your key first.' }, 400);
    if (!looksLikeAnthropicKey(key)) {
      return c.json({ error: 'That does not look like an Anthropic key — they start with “sk-ant-”.' }, 400);
    }

    // Probe before saving. A wrong key that gets stored looks exactly like a working one until the
    // first lesson fails, and at that point the error surfaces as a lost turn rather than as
    // "your key is wrong" — which is the single worst place to learn it.
    const probe = await fetch('https://api.anthropic.com/v1/models?limit=1', {
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
