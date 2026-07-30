// The one place generation picks its model: the compile role, same routing rules as everywhere
// else (plain id -> Anthropic API, ollama: -> local). Kept apart from service.ts so the service
// stays importable by tests without dragging in the AI SDK.

import { generateText } from 'ai';
import type { HarnessConfig } from '../config.js';
import { modelFor } from '../models.js';

export function compileGenerate(cfg: HarnessConfig): (prompt: string) => Promise<string> {
  return async (prompt) => (await generateText({ model: modelFor('compile', cfg), prompt })).text;
}
