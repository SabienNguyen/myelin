import { existsSync, readFileSync } from 'node:fs';
import { atomicWrite } from './atomicWrite.js';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * Where the Anthropic API key lives when it did not come from the environment.
 *
 * Deliberately NOT in the vault. The vault is markdown the learner is encouraged to open in
 * Obsidian, sync to a phone and back up to a git remote — every one of which is a way to leak a
 * key. This is the OS's own per-user config location instead, and the file is written 0600.
 *
 * The environment always wins. A user who exports ANTHROPIC_API_KEY, or a deployment that injects
 * it, should never have a stale saved key silently override them.
 */
/**
 * Where credentials (and settings.json) live when they did not come from the environment.
 *
 * MYELIN_CONFIG_DIR overrides the OS location wholesale. The e2e suite sets it: the fixture
 * backends must not read the developer's real settings.json, whose saved model ids silently
 * overrode the fixture config (a fixture's scripted models became gpt-5.6-luna mid-suite — CI
 * never saw it because CI has no ~/.config/myelin).
 */
export function credentialsPath(home = homedir(), os = platform()): string {
  if (process.env.MYELIN_CONFIG_DIR) return join(process.env.MYELIN_CONFIG_DIR, 'credentials.json');
  if (os === 'darwin') return join(home, 'Library', 'Application Support', 'Myelin', 'credentials.json');
  if (os === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Myelin', 'credentials.json');
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'myelin', 'credentials.json');
}

export interface Credentials {
  anthropicApiKey?: string;
}

export function readCredentials(path = credentialsPath()): Credentials {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Credentials;
  } catch {
    // A corrupt credentials file must not stop the app booting — the learner can just re-enter the
    // key, and the setup route will overwrite this file when they do.
    return {};
  }
}

export function writeCredentials(creds: Credentials, path = credentialsPath()): void {
  // Atomic: a save torn by a crash reads back as "no key", and the app would ask for one again.
  atomicWrite(path, `${JSON.stringify(creds, null, 2)}\n`, 0o600);
}

/**
 * Put the saved key into the environment so every Anthropic call finds it.
 *
 * The AI SDK's provider resolves `ANTHROPIC_API_KEY` lazily, per request (see models.ts), which is
 * what makes this work at runtime as well as at boot: a key entered in the setup panel takes effect
 * on the very next turn, with no restart.
 */
export function applyCredentials(path = credentialsPath()): void {
  if (process.env.ANTHROPIC_API_KEY) return;
  const key = readCredentials(path).anthropicApiKey;
  if (key) process.env.ANTHROPIC_API_KEY = key;
}

/** Shape check only — that this looks like an Anthropic key rather than a pasted URL or an empty
 *  string. Whether it actually WORKS is a question only the API can answer, which is what the
 *  setup route's live probe is for. */
export function looksLikeAnthropicKey(key: string): boolean {
  return /^sk-ant-[\w-]{20,}$/.test(key.trim());
}
