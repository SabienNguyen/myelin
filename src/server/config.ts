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
  // Optional research stack: a local SearXNG instance powering web_search/read_url tools
  // (freeform mode only). Absent -> the tools simply aren't registered.
  search: z.object({ searxng: z.string() }).optional(),
  schedule: z.object({
    digestHour: z.number().int().min(0).max(23),
    quietHours: z.tuple([z.number(), z.number()]),
    ankiSyncMinutes: z.number().int().positive(),
    ankiBacklogNudgeDays: z.number().int().positive(),
  }),
  port: z.number().int().default(4820),
});
export type HarnessConfig = z.infer<typeof configSchema>;
export type ModelRole = keyof HarnessConfig['models'];

const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

export function loadConfig(path = process.env.HARNESS_CONFIG ?? './harness.config.json'): HarnessConfig {
  const raw = JSON.parse(readFileSync(expand(path), 'utf8'));
  const cfg = configSchema.parse(raw); // throws precise zod error at boot — by design
  return { ...cfg, vault: expand(cfg.vault), loreweaver: { ...cfg.loreweaver, args: cfg.loreweaver.args.map(expand) } };
}
