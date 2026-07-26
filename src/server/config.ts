import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { z } from 'zod';

const roleSchema = z.object({ model: z.string(), effort: z.enum(['low', 'medium', 'high']).optional() });
const configSchema = z.object({
  vault: z.string(),
  student: z.string(),
  models: z.object({
    tutor: roleSchema, grader: roleSchema, quiz_gen: roleSchema,
    card_gen: roleSchema, compile: roleSchema,
  }),
  loreweaver: z.object({
    command: z.string(),
    args: z.array(z.string()),
    embeddings: z.enum(['ollama', 'fake', 'none']).default('ollama'),
  }),
  // Optional SEARCH FALLBACK for local models. An Anthropic-routed tutor gets research for free
  // via Anthropic's server-side web search (webTools.ts), so this only matters for an `ollama:`
  // tutor, which cannot use a provider-executed tool. Absent -> a local tutor has read_url but no
  // search, and instruction 13 tells it to mark what it writes as unverified.
  search: z.object({ searxng: z.string() }).optional(),
  // Optional the-gap sidecar (code_exercise blocks — I2). Absent -> /api/gap/* routes aren't
  // registered and the status badge is omitted, same "feature off when absent" pattern as search.
  gap: z.object({ url: z.string() }).optional(),
  schedule: z.object({
    digestHour: z.number().int().min(0).max(23),
    quietHours: z.tuple([z.number(), z.number()]),
    ankiSyncMinutes: z.number().int().positive(),
    ankiBacklogNudgeDays: z.number().int().positive(),
  }),
  port: z.number().int().default(4820),
  // When true (default), newly-queued chapters/papers compile automatically in the background
  // (ensureCompileDrain) as soon as conversion finishes — no manual "Compile now" click needed.
  autoCompile: z.boolean().default(true),
});
export type HarnessConfig = z.infer<typeof configSchema>;
export type ModelRole = keyof HarnessConfig['models'];

const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

export function loadConfig(path = process.env.HARNESS_CONFIG ?? './harness.config.json'): HarnessConfig {
  const raw = JSON.parse(readFileSync(expand(path), 'utf8'));
  const cfg = configSchema.parse(raw); // throws precise zod error at boot — by design
  return { ...cfg, vault: expand(cfg.vault), loreweaver: { ...cfg.loreweaver, args: cfg.loreweaver.args.map(expand) } };
}
