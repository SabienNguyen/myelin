// One-shot helpers for the single-call roles (grader, quiz_gen, card_gen, help).
import { z } from 'zod';
import type { ChatModel, Usage } from './types.js';

export interface GenerateTextOptions {
  model: ChatModel;
  system?: string;
  prompt: string;
  maxTokens?: number;
  cache?: boolean;
}

export async function generateText(opts: GenerateTextOptions): Promise<{ text: string; usage: Usage }> {
  const { text, usage } = await opts.model.generate({
    system: opts.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: opts.prompt }] }],
    maxTokens: opts.maxTokens,
    cache: opts.cache,
  });
  return { text, usage };
}

export interface GenerateStructuredOptions<T> {
  model: ChatModel;
  system?: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName?: string;
  maxTokens?: number;
}

/** Structured output as a forced tool call — the same mechanism the AI SDK used for Anthropic
 * under the hood. The one synthetic tool carries the JSON Schema; the call's input is validated
 * with schema.parse so malformed model output throws instead of flowing on half-shaped. */
export async function generateStructured<T>(
  opts: GenerateStructuredOptions<T>,
): Promise<{ object: T; usage: Usage }> {
  const name = opts.schemaName ?? 'structured_output';
  const result = await opts.model.generate({
    system: opts.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: opts.prompt }] }],
    tools: [{
      name,
      description: 'Report the result in the required structure.',
      inputSchema: z.toJSONSchema(opts.schema) as Record<string, unknown>,
    }],
    toolChoice: { name },
    maxTokens: opts.maxTokens,
  });
  const call = result.toolCalls.find((c) => c.toolName === name);
  if (!call) throw new Error(`structured output: model returned no ${name} tool call`);
  return { object: opts.schema.parse(call.input), usage: result.usage };
}
