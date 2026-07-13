import { createRequire } from 'node:module';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { SystemModelMessage } from 'ai';
import type { HarnessConfig, ModelRole } from './config.js';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? 'unset' });

export function modelFor(role: ModelRole, cfg: HarnessConfig) {
  if (process.env.LW_MOCK_MODEL) {
    // E2E hook: Task 12 provides createScriptedModel(); lazily imported to keep prod path clean.
    // createRequire because this package is ESM — bare `require` is undefined at runtime.
    const require = createRequire(import.meta.url);
    const { createScriptedModel } = require('../../tests/e2e/scripted-model.cjs');
    return createScriptedModel(process.env.LW_MOCK_MODEL);
  }
  return anthropic(cfg.models[role].model);
}

export function cachedSystem(text: string): SystemModelMessage {
  return {
    role: 'system', content: text,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  } as SystemModelMessage;
}
