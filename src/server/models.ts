import { createRequire } from 'node:module';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { SystemModelMessage } from 'ai';
import type { HarnessConfig, ModelRole } from './config.js';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? 'unset' });

const OLLAMA_PREFIX = 'ollama:';
const ollama = createOpenAICompatible({
  name: 'ollama',
  baseURL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
});

export function modelFor(role: ModelRole, cfg: HarnessConfig) {
  if (process.env.LW_MOCK_MODEL) {
    // E2E hook: Task 12 provides createScriptedModel(); lazily imported to keep prod path clean.
    // createRequire because this package is ESM — bare `require` is undefined at runtime.
    const require = createRequire(import.meta.url);
    const { createScriptedModel } = require('../../tests/e2e/scripted-model.cjs');
    return createScriptedModel(process.env.LW_MOCK_MODEL);
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
