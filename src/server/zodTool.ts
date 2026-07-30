// LoopTool construction for the harness's zod-schema'd local tools (session, web, ingest).
// Preserves the validation the AI SDK's tool() applied implicitly: inputs parse against the zod
// schema before execute, so a malformed call surfaces to the model as an error tool-result naming
// the bad field instead of a TypeError from inside the tool. A tool with no execute (the block
// tools) declares only — the loop halts on it and the client supplies the output.
import { z } from 'zod';
import type { LoopTool } from './llm/index.js';

export function zodTool<S extends z.ZodType>(
  name: string,
  opts: {
    description: string;
    input: S;
    execute?: (input: z.infer<S>) => Promise<unknown>;
  },
): LoopTool {
  const { description, input, execute } = opts;
  return {
    name,
    description,
    inputSchema: z.toJSONSchema(input) as Record<string, unknown>,
    ...(execute ? { execute: async (raw: unknown) => execute(input.parse(raw)) } : {}),
  };
}
