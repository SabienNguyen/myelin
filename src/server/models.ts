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

const OLLAMA_PREFIX = 'ollama:';
const ollama = createOpenAICompatible({
  name: 'ollama',
  baseURL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
});

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
    return ollama.chatModel(modelId.slice(OLLAMA_PREFIX.length));
  }
  return anthropic(modelId);
}

export function cachedSystem(text: string): SystemModelMessage {
  return {
    role: 'system', content: text,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  } as SystemModelMessage;
}
