import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { credentialsPath } from './credentials.js';
import type { HarnessConfig, ModelRole } from './config.js';
import { removedRouteMessage } from './config.js';

/**
 * What the in-app models popover saves: per-role model ids and the provider-endpoint variables
 * models.ts reads from process.env. Lives beside credentials.json (same directory, same reasons —
 * the env group can hold API keys, so it stays out of the vault and is written 0600).
 */
export interface Settings {
  models?: Partial<Record<ModelRole, string>>;
  /** The rails checkbox beside the tutor id — mirrors config's models.tutor.rails. */
  tutorRails?: boolean;
  env?: Partial<Record<ProviderEnvKey, string>>;
}

export const PROVIDER_ENV_KEYS = [
  'OLLAMA_BASE_URL', 'OLLAMA_API_KEY', 'OPENAI_COMPAT_BASE_URL', 'OPENAI_COMPAT_API_KEY',
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
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  // `mode` on writeFileSync is ignored when the file already exists — see writeCredentials.
  try { chmodSync(path, 0o600); } catch { /* best effort — Windows has no POSIX mode */ }
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
  for (const [role, id] of Object.entries(saved.models ?? {})) {
    if (!(role in cfg.models) || typeof id !== 'string' || !id.trim()) continue;
    if (id.startsWith('claude-sdk:')) {
      // The PUT route refuses to save this id, so it can only appear here by hand-editing.
      // Skipping (with the same message loadConfig throws for the config file) keeps the boot
      // guard's promise: a machine with a key never silently bills for a subscription route.
      console.error(removedRouteMessage([`${role}: "${id}"`], path));
      continue;
    }
    cfg.models[role as ModelRole].model = id.trim();
  }
  if (typeof saved.tutorRails === 'boolean') cfg.models.tutor.rails = saved.tutorRails;
  applyEnvValues(saved.env ?? {});
}
