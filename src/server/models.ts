import { createRequire } from 'node:module';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { SystemModelMessage } from 'ai';
import type { HarnessConfig, ModelRole } from './config.js';

// No explicit apiKey: the provider resolves ANTHROPIC_API_KEY per request (its getHeaders is a
// closure), so a key saved through the setup panel at runtime takes effect on the next turn with
// no restart. Passing `process.env.ANTHROPIC_API_KEY ?? 'unset'` here — as this did — froze
// whatever was set at module load, which made the first-run flow impossible to fix without one.
const anthropic = createAnthropic({});

// Both OpenAI-compatible routes construct their provider per call, for the same reason: the
// provider bakes baseURL and Authorization into closures at construction, so a module-level
// instance would freeze whatever the env held at import time. Construction is cheap (no I/O).
const OLLAMA_PREFIX = 'ollama:';
function ollamaModel(modelId: string) {
  return createOpenAICompatible({
    name: 'ollama',
    baseURL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
    // Unset means no Authorization header — the common local case. Set it for a key-protected
    // Ollama reverse proxy.
    apiKey: process.env.OLLAMA_API_KEY,
  }).chatModel(modelId);
}

const OPENAI_PREFIX = 'openai:';
function openaiCompatModel(modelId: string) {
  const baseURL = process.env.OPENAI_COMPAT_BASE_URL;
  // No localhost fallback here: unlike Ollama there is no conventional default port, and a guessed
  // URL would surface as a confusing connection error mid-lesson instead of this message at call
  // time. A missing OPENAI_COMPAT_API_KEY is fine (keyless proxies exist); a wrong one is the
  // provider's 401 to report.
  if (!baseURL) {
    throw new Error(
      `model "openai:${modelId}" needs OPENAI_COMPAT_BASE_URL set to the provider's `
      + `OpenAI-compatible endpoint, e.g. https://openrouter.ai/api/v1 `
      + `(and OPENAI_COMPAT_API_KEY if the provider requires a key)`,
    );
  }
  return createOpenAICompatible({
    name: 'openai-compatible',
    baseURL,
    apiKey: process.env.OPENAI_COMPAT_API_KEY,
  }).chatModel(modelId);
}

// One scripted instance per script path, so every role pops from the SAME turn sequence. Without
// this, the tutor session (which holds its model) advances the counter while each grading call
// (fresh modelFor per grade) restarts at turn 0 — and the grader replays the first tool-call turn
// forever instead of reaching its scripted verdict.
const scriptedCache = new Map<string, unknown>();

export function modelFor(role: ModelRole, cfg: HarnessConfig) {
  if (process.env.LW_MOCK_MODEL) {
    // E2E hook: Task 12 provides createScriptedModel(); lazily imported to keep prod path clean.
    // createRequire because this package is ESM — bare `require` is undefined at runtime.
    const scriptPath = process.env.LW_MOCK_MODEL;
    if (!scriptedCache.has(scriptPath)) {
      const require = createRequire(import.meta.url);
      const { createScriptedModel } = require('../../tests/e2e/scripted-model.cjs');
      scriptedCache.set(scriptPath, createScriptedModel(scriptPath));
    }
    return scriptedCache.get(scriptPath) as ReturnType<typeof anthropic>;
  }
  const modelId = cfg.models[role].model;
  if (modelId.startsWith(OLLAMA_PREFIX)) {
    return ollamaModel(modelId.slice(OLLAMA_PREFIX.length));
  }
  if (modelId.startsWith(OPENAI_PREFIX)) {
    return openaiCompatModel(modelId.slice(OPENAI_PREFIX.length));
  }
  return anthropic(modelId);
}

export function cachedSystem(text: string): SystemModelMessage {
  return {
    role: 'system', content: text,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  } as SystemModelMessage;
}
