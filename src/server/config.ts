import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const roleSchema = z.object({ model: z.string(), effort: z.enum(['low', 'medium', 'high']).optional() });

const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

/**
 * Where a fresh install puts the vault.
 *
 * A vault is Obsidian-compatible markdown the learner is *meant* to open, edit and back up — so it
 * belongs where they keep documents, not in an application-support directory where they would never
 * find it. `~/Documents` when that exists (macOS and Windows always, most Linux desktops), and a
 * plain `~/loreweaver-vault` when it does not, which is the common case on a server or a minimal
 * Linux install.
 */
export function defaultVaultPath(home = homedir()): string {
  const docs = join(home, 'Documents');
  return existsSync(docs) ? join(docs, 'Loreweaver') : join(home, 'loreweaver-vault');
}

/**
 * Find the Loreweaver MCP server without being told where it is.
 *
 * This used to be mandatory config, and the example pointed at one particular person's checkout
 * (`~/Dev/personal/loreweaver`) — which meant a fresh clone could not start at all until someone
 * edited a path by hand. The ladder below covers the three ways the server can actually be present:
 * installed as a dependency (how a packaged app ships it), a sibling checkout (how this repo is
 * developed), or explicitly named by env for anything unusual.
 *
 * The runner follows from the file: compiled `.js` runs on this very Node binary, which matters for
 * a packaged app that has no `npx` on PATH; `.ts` needs tsx, which only a dev checkout would hit.
 */
export function resolveLoreweaver(from = dirname(fileURLToPath(import.meta.url))): {
  command: string; args: string[];
} {
  const explicit = process.env.LOREWEAVER_ENTRY;
  if (explicit) return runnerFor(expand(explicit));

  // Installed as a dependency — a packaged app, or `npm i file:../loreweaver` in a dev tree.
  try {
    return runnerFor(createRequire(import.meta.url).resolve('loreweaver/dist/server.js'));
  } catch { /* not installed; keep looking */ }

  // Sibling checkout. `from` is src/server/ in dev and dist/server/ once built, so walk up far
  // enough to clear both, and prefer the build over the source at each level.
  for (const up of ['../../..', '../../../..']) {
    for (const rel of ['loreweaver/dist/server.js', 'loreweaver/src/server.ts']) {
      const candidate = resolve(from, up, rel);
      if (existsSync(candidate)) return runnerFor(candidate);
    }
  }

  // Nothing found. Return the dependency path anyway rather than throwing here: the failure the
  // learner should see is a startup message naming what is missing (index.ts), not a config parse
  // error from a module they never edited.
  return runnerFor(resolve(from, '../../node_modules/loreweaver/dist/server.js'));
}

function runnerFor(entry: string): { command: string; args: string[] } {
  return entry.endsWith('.ts')
    ? { command: 'npx', args: ['tsx', entry] }
    : { command: process.execPath, args: [entry] };
}

/**
 * Every field has a default, and the config file itself is optional.
 *
 * The point is that `npm start` works on a fresh clone with nothing but an API key. Before this,
 * fifteen fields were mandatory — vault path, student id, five model roles, the Loreweaver command,
 * four schedule numbers — so the first thing a new user met was a zod error listing all of them.
 * Anything they do want to change still overrides, and unknown keys are stripped (which is what
 * lets the example file carry a `_modelRoutes` note).
 */
const configSchema = z.object({
  vault: z.string().default(defaultVaultPath()),
  // The vault records evidence per student id, so this only matters if two people share a vault.
  student: z.string().default(userInfo().username || 'student'),
  models: z.object({
    // Sonnet for the roles that write prose the learner reads, Haiku for the mechanical ones.
    // Deliberately not Opus by default: the tutor role runs on every single turn, and choosing to
    // spend that is the user's call, not a default. Override any role in harness.config.json.
    tutor: roleSchema.default({ model: 'claude-sonnet-5' }),
    grader: roleSchema.default({ model: 'claude-haiku-4-5' }),
    quiz_gen: roleSchema.default({ model: 'claude-sonnet-5' }),
    card_gen: roleSchema.default({ model: 'claude-haiku-4-5' }),
    compile: roleSchema.default({ model: 'claude-sonnet-5' }),
    // prefault, not default: in zod 4 `.default()` takes the OUTPUT type (so it would have to
    // restate all five roles), while `.prefault()` feeds `{}` through the schema and lets each
    // role's own default apply. Same intent — "an absent `models` block means all defaults".
  }).prefault({}),
  loreweaver: z.object({
    command: z.string(),
    args: z.array(z.string()),
    // 'ollama' gives semantic search and find_analogies; without Ollama running it degrades to
    // lexical-only search (loreweaver's context.ts catches the failure and reports
    // `embeddingsError`), so it is safe as a default rather than a prerequisite.
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
    digestHour: z.number().int().min(0).max(23).default(9),
    quietHours: z.tuple([z.number(), z.number()]).default([22, 8]),
    ankiSyncMinutes: z.number().int().positive().default(30),
    ankiBacklogNudgeDays: z.number().int().positive().default(3),
  }).prefault({}),
  port: z.number().int().default(4820),
  // When true (default), newly-queued chapters/papers compile automatically in the background
  // (ensureCompileDrain) as soon as conversion finishes — no manual "Compile now" click needed.
  autoCompile: z.boolean().default(true),
});
export type HarnessConfig = z.infer<typeof configSchema>;
export type ModelRole = keyof HarnessConfig['models'];

/** Whether a config file was found, and where. index.ts reports this at boot so a typo'd
 *  HARNESS_CONFIG shows up as a message rather than as silently-default behaviour. */
export interface ConfigSource { path: string; found: boolean }
let lastSource: ConfigSource = { path: '', found: false };
export const configSource = (): ConfigSource => lastSource;

export function loadConfig(path = process.env.HARNESS_CONFIG ?? './harness.config.json'): HarnessConfig {
  const file = expand(path);
  const found = existsSync(file);
  lastSource = { path: file, found };
  // A MISSING file is not an error — it means "use the defaults". A file that exists but is
  // malformed still throws a precise zod/JSON error at boot, by design: the user wrote it, so they
  // want to know it is wrong rather than have it quietly ignored.
  const raw = found ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const cfg = configSchema.parse({
    ...raw,
    // Resolved here rather than as a schema default so the filesystem probe only runs when it is
    // actually needed — importing this module stays side-effect-free.
    loreweaver: raw.loreweaver ?? resolveLoreweaver(),
  });
  return {
    ...cfg,
    vault: expand(cfg.vault),
    loreweaver: { ...cfg.loreweaver, args: cfg.loreweaver.args.map(expand) },
  };
}
