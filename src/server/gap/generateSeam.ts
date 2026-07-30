// The one place generation picks its model: the compile role, same routing rules as everywhere
// else (plain id -> Anthropic API, ollama: -> local). Kept apart from service.ts so the service
// stays importable by tests without dragging in the model layer.

import { generateText } from '../llm/index.js';
import type { HarnessConfig } from '../config.js';
import { chatModelFor } from '../models.js';
import { recordUsage } from '../usageLedger.js';

export function compileGenerate(cfg: HarnessConfig): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const { text, usage } = await generateText({ model: chatModelFor('compile', cfg), prompt });
    recordUsage(cfg.vault, { role: 'compile', model: cfg.models?.compile?.model ?? 'unknown', usage });
    return text;
  };
}
