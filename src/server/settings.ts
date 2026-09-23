import { existsSync, readFileSync } from 'node:fs';
import { atomicWrite } from './atomicWrite.js';
import { dirname, join } from 'node:path';
import { credentialsPath } from './credentials.js';
import type { HarnessConfig, ModelRole } from './config.js';
import { removedRouteMessage, roleSchema } from './config.js';

/** A role saved as more than a bare id — `{ model, sampler: {...}, effort, contextTokens,
 *  concurrency }`, hand-edited into settings.json to tune a local model beyond what the popover
 *  exposes. Exactly the shape roleSchema (config.ts) produces, so this can never diverge from what
 *  harness.config.json itself would accept — see applySettings, which validates with that schema. */
export type RoleObject = HarnessConfig['models'][ModelRole];

/**
 * What the in-app models popover saves: per-role model ids and context windows, and the
 * provider-endpoint variables models.ts reads from process.env. Lives beside credentials.json
 * (same directory, same reasons — the env group can hold API keys, so it stays out of the vault
 * and is written 0600).
 */
export interface Settings {
  // Almost always a bare id, written by the PUT route. The object form is never written by this
  // app — only ever by hand — and applySettings validates it before anything reads it live.
  models?: Partial<Record<ModelRole, string | RoleObject>>;
  // Its own group rather than a field on `models`, because every settings.json written before this
  // maps a role straight to an id string and must keep loading unchanged.
  contextTokens?: Partial<Record<ModelRole, number>>;
  env?: Partial<Record<ProviderEnvKey, string>>;
}

export const PROVIDER_ENV_KEYS = [
  'OLLAMA_BASE_URL', 'OLLAMA_API_KEY', 'OPENAI_COMPAT_BASE_URL', 'OPENAI_COMPAT_API_KEY',
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY',
] as const;
export type ProviderEnvKey = typeof PROVIDER_ENV_KEYS[number];

export function settingsPath(): string {
  return join(dirname(credentialsPath()), 'settings.json');
}

export function readSettings(path = settingsPath()): Settings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Settings;
  } catch {
    // Same call credentials.ts makes on a corrupt file: boot anyway. Everything here can be
    // re-entered in the popover, and the next save overwrites the file.
    return {};
  }
}

export function writeSettings(settings: Settings, path = settingsPath()): void {
  atomicWrite(path, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
}

/**
 * Which provider vars were REAL environment variables, set before this module wrote anything.
 *
 * Captured lazily on the first call: applyEnvValues is the only writer of these four keys, and it
 * captures before it writes, so anything present at capture time came from the environment. The
 * routes need this to report a saved value as shadowed, and applyEnvValues needs it to keep a real
 * variable winning over a saved one — the rule credentials.ts applies to ANTHROPIC_API_KEY.
 */
let realEnv: Record<ProviderEnvKey, boolean> | null = null;
export function envShadow(): Record<ProviderEnvKey, boolean> {
  realEnv ??= Object.fromEntries(
    PROVIDER_ENV_KEYS.map((k) => [k, Boolean(process.env[k])]),
  ) as Record<ProviderEnvKey, boolean>;
  return realEnv;
}
/** Test seam: forget the snapshot so a test can stub a different environment. */
export function resetEnvShadow(): void { realEnv = null; }

/** Put saved provider values into process.env — except where a real environment variable already
 *  answers, which keeps winning. models.ts reads these per call, so this is live: no restart. */
export function applyEnvValues(env: Partial<Record<ProviderEnvKey, string>>): void {
  const shadow = envShadow();
  for (const k of PROVIDER_ENV_KEYS) {
    const v = env[k]?.trim();
    if (v && !shadow[k]) process.env[k] = v;
  }
}

/** Boot-time overlay of settings.json onto the loaded config. Mutates cfg.models in place — the
 *  same object every route holds — which is also how the PUT route makes a save live. */
export function applySettings(cfg: HarnessConfig, path = settingsPath()): void {
  const saved = readSettings(path);
  for (const [role, value] of Object.entries(saved.models ?? {})) {
    if (!(role in cfg.models)) continue;
    const roleKey = role as ModelRole;

    if (typeof value === 'string') {
      if (!value.trim()) continue;
      const id = value.trim();
      if (id.startsWith('claude-sdk:')) {
        // The PUT route refuses to save this id, so it can only appear here by hand-editing.
        // Skipping (with the same message loadConfig throws for the config file) keeps the boot
        // guard's promise: a machine with a key never silently bills for a subscription route.
        console.error(removedRouteMessage([`${role}: "${id}"`], path));
        continue;
      }
      cfg.models[roleKey].model = id;
      continue;
    }

    // Not a string: either a role hand-tuned as a full object (the motivating case is a sampler
    // for a local model — `{ model, sampler: { topP, topK, minP } }`) or plain garbage from a bad
    // edit. Both go through roleSchema, the exact validator harness.config.json itself is parsed
    // with, so a saved override can never accept something the config file would reject.
    //
    // This used to be `typeof id !== 'string' ... continue`, with nothing printed anywhere — a
    // role saved as an object silently ran on the default model forever. Still ignored on
    // failure, but never silent about it.
    const parsed = roleSchema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
      console.error(`${path}: models.${role} is not a valid model id or role config (${issues}) `
        + `— ${role} keeps its default`);
      continue;
    }
    const id = parsed.data.model.trim();
    if (!id) continue; // a blank model in the object — same silent skip as a blank string id
    if (id.startsWith('claude-sdk:')) {
      console.error(removedRouteMessage([`${role}: "${id}"`], path));
      continue;
    }
    // Every field the object declares lands on cfg.models[role] — the same shape
    // harness.config.json itself produces through this schema — so a hand-tuned sampler survives
    // instead of being dropped in favour of just the model id.
    Object.assign(cfg.models[roleKey], parsed.data, { model: id });
  }
  for (const [role, tokens] of Object.entries(saved.contextTokens ?? {})) {
    if (!(role in cfg.models)) continue;
    if (!Number.isInteger(tokens) || (tokens as number) <= 0) {
      // The PUT route refuses these, so only a hand edit gets here. Saying so out loud beats
      // running the role on the default budget while the file looks like it declares one.
      console.error(`${path}: contextTokens.${role} must be a whole number of tokens above zero, `
        + `not ${JSON.stringify(tokens)} — ignoring it`);
      continue;
    }
    cfg.models[role as ModelRole].contextTokens = tokens as number;
  }
  applyEnvValues(saved.env ?? {});
}
