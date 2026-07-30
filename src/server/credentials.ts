import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
export function credentialsPath(home = homedir(), os = platform()): string {
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
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  // Explicit chmod as well as the open mode: if the file already existed, `mode` on writeFileSync
  // is ignored, so a file created loosely once would stay loose forever.
  try { chmodSync(path, 0o600); } catch { /* best effort — Windows has no POSIX mode */ }
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
