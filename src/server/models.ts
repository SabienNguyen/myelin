import { createRequire } from 'node:module';
import { anthropicModel, openaiCompatModel, type ChatModel, type ChatRequest } from './llm/index.js';
import type { HarnessConfig, ModelRole } from './config.js';

// The three model routes resolved onto the first-party ChatModel. Env vars are read PER CALL, not
// at module load: the adapters take plain option values, and a cached instance would freeze
// whatever the env held at resolve time — the setup panel saves keys and base URLs at runtime and
// the next turn must see them without a restart.
const OLLAMA_PREFIX = 'ollama:';
const OPENAI_PREFIX = 'openai:';

// One scripted instance per script path, so every role pops from the SAME turn sequence. Without
// this, the tutor session (which holds its model) advances the counter while each grading call
// (fresh chatModelFor per grade) restarts at turn 0 — and the grader replays the first tool-call
// turn forever instead of reaching its scripted verdict.
const scriptedChatCache = new Map<string, ChatModel>();

/** The role's configured effort rides the resolved model, not the call sites: every ChatRequest
 * built through runLoop or the generate* helpers picks it up with no signature changes anywhere
 * between config and adapter. An effort already on the request wins (no caller sets one today). */
export function withEffort(model: ChatModel, effort: NonNullable<ChatRequest['effort']>): ChatModel {
  return {
    ...(model.supportsResponseFormat !== undefined
      ? { supportsResponseFormat: model.supportsResponseFormat } : {}),
    generate: (req) => model.generate({ ...req, effort: req.effort ?? effort }),
    stream: (req) => model.stream({ ...req, effort: req.effort ?? effort }),
  };
}

export function chatModelFor(role: ModelRole, cfg: HarnessConfig): ChatModel {
  if (process.env.LW_MOCK_MODEL) {
    // E2E hook: tests/e2e/scripted-model.cjs provides createChatModel(); lazily imported to keep
    // the prod path clean. createRequire because this package is ESM — bare `require` is
    // undefined at runtime.
    const scriptPath = process.env.LW_MOCK_MODEL;
    if (!scriptedChatCache.has(scriptPath)) {
      const require = createRequire(import.meta.url);
      const { createChatModel } = require('../../tests/e2e/scripted-model.cjs');
      scriptedChatCache.set(scriptPath, createChatModel(scriptPath) as ChatModel);
    }
    // Unwrapped on purpose: scripted models replay fixed turns and ignore effort by design.
    return scriptedChatCache.get(scriptPath)!;
  }
  const { model: modelId, effort } = cfg.models[role];
  const wrap = (m: ChatModel) => (effort !== undefined ? withEffort(m, effort) : m);
  if (modelId.startsWith(OLLAMA_PREFIX)) {
    return wrap(openaiCompatModel({
      modelId: modelId.slice(OLLAMA_PREFIX.length),
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
      // Unset means no Authorization header — the common local case. Set it for a key-protected
      // Ollama reverse proxy.
      apiKey: process.env.OLLAMA_API_KEY,
    }));
  }
  if (modelId.startsWith(OPENAI_PREFIX)) {
    const id = modelId.slice(OPENAI_PREFIX.length);
    const baseUrl = process.env.OPENAI_COMPAT_BASE_URL;
    // No localhost fallback here: unlike Ollama there is no conventional default port, and a
    // guessed URL would surface as a confusing connection error mid-lesson instead of this
    // message at call time. A missing OPENAI_COMPAT_API_KEY is fine (keyless proxies exist);
    // a wrong one is the provider's 401 to report.
    if (!baseUrl) {
      throw new Error(
        `model "openai:${id}" needs OPENAI_COMPAT_BASE_URL set to the provider's `
        + `OpenAI-compatible endpoint, e.g. https://openrouter.ai/api/v1 `
        + `(and OPENAI_COMPAT_API_KEY if the provider requires a key)`,
      );
    }
    return wrap(openaiCompatModel({ modelId: id, baseUrl, apiKey: process.env.OPENAI_COMPAT_API_KEY }));
  }
  // No apiKey passed: the adapter resolves ANTHROPIC_API_KEY per request, so a key saved through
  // the setup panel at runtime takes effect on the next turn with no restart. Passing
  // `process.env.ANTHROPIC_API_KEY ?? 'unset'` here — as a predecessor of this code did — froze
  // whatever was set at module load, which made the first-run flow impossible to fix without one.
  return wrap(anthropicModel({ modelId }));
}
