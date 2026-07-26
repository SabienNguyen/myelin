// The one place generation picks its model: the compile role, same routing rules as everywhere
// else (plain id -> Anthropic API, claude-sdk: -> the local login, ollama: -> local). Kept apart
// from service.ts so the service stays importable by tests without dragging in the AI SDK.

import { generateText } from 'ai';
import type { HarnessConfig } from '../config.js';
import { claudeSdkGenerate, isClaudeSdkModel, stripClaudeSdkPrefix } from '../claudeSdk.js';
import { modelFor } from '../models.js';

export function compileGenerate(cfg: HarnessConfig): (prompt: string) => Promise<string> {
  const id = cfg.models.compile.model;
  if (isClaudeSdkModel(id)) {
    return async (prompt) => (await claudeSdkGenerate({ model: stripClaudeSdkPrefix(id), prompt, maxTurns: 1 })).text;
  }
  return async (prompt) => (await generateText({ model: modelFor('compile', cfg), prompt })).text;
}
