import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { credentialsPath, readCredentials, writeCredentials } from './credentials.js';

const exec = promisify(execFile);

/**
 * How the app is authorised to think. Two routes, and the point of naming them is that the learner
 * should not have to understand model-id prefixes to pick one.
 *
 *   - `api-key`   — an Anthropic API key, billed per token.
 *   - `subscription` — the local `claude` CLI login, billed against a Claude Pro/Max plan, no key.
 *
 * `route` is stored beside the key rather than in harness.config.json because a packaged app's own
 * directory is read-only, and because it is a per-machine fact (which login exists HERE), not a
 * per-project one.
 */
export type AuthRoute = 'api-key' | 'subscription';

/** Model ids for each role on the subscription route. `claude-sdk:` draws on the local login; the
 *  aliases are what the Agent SDK expects, not API model ids. */
const SUBSCRIPTION_MODELS: Record<string, string> = {
  tutor: 'claude-sdk:sonnet',
  grader: 'claude-sdk:haiku',
  quiz_gen: 'claude-sdk:sonnet',
  card_gen: 'claude-sdk:haiku',
  compile: 'claude-sdk:sonnet',
};

export interface SubscriptionStatus {
  /** Is the `claude` CLI on PATH at all? */
  cliFound: boolean;
  cliVersion?: string;
  /** Does that CLI have a login on this machine? */
  loggedIn: boolean;
  /** Shown back to the learner so the offer is concrete: "Continue as you@example.com". */
  email?: string;
}

/**
 * Is there a Claude subscription login on this machine?
 *
 * Two independent signals, because either alone lies. The CLI can be installed and never logged in;
 * a stale `~/.claude.json` can name an account whose token has since expired. So this reports what it
 * actually saw and nothing more — the UI offers the route, and a genuinely dead token still surfaces
 * as a failed first turn. Deliberately NOT verified by running a real query: that would cost the
 * learner tokens and several seconds on a screen whose entire job is to get out of the way.
 */
export async function subscriptionStatus(home = homedir()): Promise<SubscriptionStatus> {
  let cliFound = false;
  let cliVersion: string | undefined;
  try {
    // --version and not `claude -p`: no tokens, no network, ~50ms.
    const { stdout } = await exec('claude', ['--version'], { timeout: 5_000 });
    cliFound = true;
    cliVersion = stdout.trim().split('\n')[0];
  } catch { /* not installed, or not on this PATH */ }

  let loggedIn = false;
  let email: string | undefined;
  const stateFile = join(home, '.claude.json');
  if (existsSync(stateFile)) {
    try {
      const account = JSON.parse(readFileSync(stateFile, 'utf8'))?.oauthAccount;
      if (account?.accountUuid) {
        loggedIn = true;
        email = typeof account.emailAddress === 'string' ? account.emailAddress : undefined;
      }
    } catch { /* unreadable or not JSON — treat as no login rather than failing setup */ }
  }
  return { cliFound, cliVersion, loggedIn, email };
}

export function readRoute(path = credentialsPath()): AuthRoute | null {
  const stored = readCredentials(path) as { route?: AuthRoute };
  return stored.route === 'subscription' || stored.route === 'api-key' ? stored.route : null;
}

export function writeRoute(route: AuthRoute, path = credentialsPath()): void {
  writeCredentials({ ...readCredentials(path), route }, path);
}

/**
 * Apply the stored route to a loaded config, in place.
 *
 * In place, and mutating the object every route builder already holds, because the alternative is
 * making the learner restart the app to finish signing in. chatRoute.ts picks its tutor
 * implementation per request precisely so this can take effect on the next turn.
 *
 * A MODEL chosen explicitly in harness.config.json always wins; the route only decides how that
 * model is reached and paid for. So `"tutor": {"model": "ollama:qwen"}` stays untouched, and an
 * explicit plain Anthropic id like `claude-sonnet-5` keeps its exact model but rides the local
 * login as `claude-sdk:claude-sonnet-5` — the alternative was a config that pins any API model
 * making "Use my Claude subscription" a click that succeeds server-side and changes nothing the
 * user can see, because every role still demanded the key they were trying not to paste.
 */
export function applyRoute(
  cfg: { models: Record<string, { model: string }> },
  explicitRoles: Set<string>,
  route: AuthRoute | null,
): void {
  if (route !== 'subscription') return;
  for (const [role, entry] of Object.entries(cfg.models)) {
    if (!explicitRoles.has(role)) {
      if (SUBSCRIPTION_MODELS[role]) entry.model = SUBSCRIPTION_MODELS[role];
    } else if (!entry.model.includes(':')) {
      entry.model = `claude-sdk:${entry.model}`;
    }
  }
}
