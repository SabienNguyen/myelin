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

/** JSON.parse with an error a rejection prompt can carry: names the schema and quotes the head of
 * the text. Reached only when a provider ACCEPTED response_format and still emitted non-JSON. */
function parseStructuredText(text: string, name: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`structured output: model returned unparseable JSON for ${name}: ${text.slice(0, 200)}`);
  }
}

/**
 * Structured output, by whichever mechanism the model's wire supports.
 *
 * Adapters that honor ChatRequest.responseSchema (supportsResponseFormat — openai-compat) get
 * constrained decoding: the decoder itself is held to the JSON Schema, so a small model cannot
 * produce invalid JSON. The result is usually the JSON as text; when the endpoint rejected
 * response_format the adapter fell back to the forced-tool request, and the same call arrives as a
 * tool call — both shapes are read here. Everything else (anthropic) runs the forced tool call
 * directly, the same mechanism the AI SDK used under the hood. Either way the value goes through
 * schema.parse, so malformed model output throws instead of flowing on half-shaped.
 */
export async function generateStructured<T>(
  opts: GenerateStructuredOptions<T>,
): Promise<{ object: T; usage: Usage }> {
  const name = opts.schemaName ?? 'structured_output';
  const jsonSchema = z.toJSONSchema(opts.schema) as Record<string, unknown>;
  const base = {
    system: opts.system,
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: opts.prompt }] }],
    maxTokens: opts.maxTokens,
  };
  if (opts.model.supportsResponseFormat) {
    const result = await opts.model.generate({ ...base, responseSchema: { name, schema: jsonSchema } });
    const call = result.toolCalls.find((c) => c.toolName === name);
    const raw = call ? call.input : parseStructuredText(result.text, name);
    return { object: opts.schema.parse(raw), usage: result.usage };
  }
  const result = await opts.model.generate({
    ...base,
    tools: [{
      name,
      description: 'Report the result in the required structure.',
      inputSchema: jsonSchema,
    }],
    toolChoice: { name },
  });
  const call = result.toolCalls.find((c) => c.toolName === name);
  if (!call) throw new Error(`structured output: model returned no ${name} tool call`);
  return { object: opts.schema.parse(call.input), usage: result.usage };
}
