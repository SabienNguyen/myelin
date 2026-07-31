// Which of the three Ollama situations a learner is actually in, and what to tell them about it.
//
// The pull proxy used to answer this question with one sentence for every failure: "couldn't reach
// Ollama — install it from ollama.com". That sentence is right for exactly one of the cases below
// and insulting in the other two, because it tells someone who has Ollama installed to go install
// it. Worse, it made the "choose a model, we install it" promise dead-end for the one person it was
// written for: a newcomer who has never installed Ollama gets an error where they were promised a
// download.
//
// So the states are distinguished here, once, and every caller branches on the tag instead of
// guessing from a string.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** How long we wait for the daemon before calling it down. The dialog opens on this, so it is short
 *  — a running Ollama answers /api/tags in single-digit milliseconds. */
const PROBE_TIMEOUT_MS = 1500;
/** `which`/`where` against a cold filesystem cache; still effectively instant. */
const WHICH_TIMEOUT_MS = 2000;

export type OllamaPlatform = 'macos' | 'windows' | 'linux';

export interface InstallHint {
  platform: OllamaPlatform;
  /** The official download page — what the "Install Ollama" button opens. */
  url: string;
  /** A one-line install where the platform has an official one. macOS and Windows ship a graphical
   *  installer instead, so this is absent there rather than invented. */
  command?: string;
}

export type OllamaState =
  /** Daemon answered. Nothing to do — pulls will work. */
  | { state: 'running'; root: string }
  /** Binary is on disk but nothing is listening. We can offer to start it. */
  | { state: 'stopped'; root: string; binary: string }
  /** No daemon and no binary. This is the one that needs an install, and the only one where
   *  pointing at ollama.com is the correct thing to say. */
  | { state: 'absent'; root: string; install: InstallHint };

export function currentPlatform(p = platform()): OllamaPlatform {
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  return 'linux';
}

export function installHint(p: OllamaPlatform = currentPlatform()): InstallHint {
  if (p === 'linux') {
    // The official script, quoted exactly as ollama.com/download publishes it. We show it for the
    // learner to run themselves rather than piping a remote script into a shell on their behalf.
    return { platform: p, url: 'https://ollama.com/download/linux', command: 'curl -fsSL https://ollama.com/install.sh | sh' };
  }
  return { platform: p, url: `https://ollama.com/download/${p === 'macos' ? 'mac' : 'windows'}` };
}

/** Where the installers put the CLI when it is not on this process's PATH. An Electron app launched
 *  from Finder or the Start menu inherits a login shell's PATH only sometimes, so a binary that
 *  `which` cannot see is very often still there — checking these paths is what stops us telling a
 *  macOS user with Ollama installed that they have no Ollama. */
export function knownBinaryPaths(p: OllamaPlatform, home: string): string[] {
  if (p === 'macos') {
    return [
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
      '/Applications/Ollama.app/Contents/Resources/ollama',
      `${home}/Applications/Ollama.app/Contents/Resources/ollama`,
    ];
  }
  if (p === 'windows') {
    return [
      `${home}\\AppData\\Local\\Programs\\Ollama\\ollama.exe`,
      'C:\\Program Files\\Ollama\\ollama.exe',
    ];
  }
  return ['/usr/local/bin/ollama', '/usr/bin/ollama', `${home}/.local/bin/ollama`];
}

export interface DetectDeps {
  /** Injected so tests drive the daemon probe without a listener. */
  fetchImpl?: typeof fetch;
  /** Injected so tests decide whether the binary is "on PATH" without one being installed. */
  which?: (p: OllamaPlatform) => Promise<string | null>;
  exists?: (path: string) => boolean;
  platform?: OllamaPlatform;
  home?: string;
}

/** `which ollama` / `where ollama`, returning the resolved path or null. Errors — including the
 *  non-zero exit that means "not found" — are all just "no". */
async function whichOllama(p: OllamaPlatform): Promise<string | null> {
  const [cmd, arg] = p === 'windows' ? ['where', 'ollama'] : ['which', 'ollama'];
  try {
    const { stdout } = await run(cmd, [arg], { timeout: WHICH_TIMEOUT_MS });
    // `where` can return several lines; the first is the one that would run.
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    return first ?? null;
  } catch {
    return null;
  }
}

/**
 * Probe the daemon, and only if it is down go looking for the binary.
 *
 * The order matters and is the cheap path first: a running Ollama — the common case for anyone
 * past first run — costs one local HTTP round trip and never shells out.
 */
export async function detectOllama(root: string, deps: DetectDeps = {}): Promise<OllamaState> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(`${root}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res.ok) return { state: 'running', root };
  } catch {
    // Fall through: unreachable is the question, not the answer.
  }

  const p = deps.platform ?? currentPlatform();
  const home = deps.home ?? process.env.HOME ?? process.env.USERPROFILE ?? '';
  const doesExist = deps.exists ?? existsSync;

  const onPath = await (deps.which ?? whichOllama)(p);
  if (onPath) return { state: 'stopped', root, binary: onPath };

  const found = knownBinaryPaths(p, home).find(doesExist);
  if (found) return { state: 'stopped', root, binary: found };

  return { state: 'absent', root, install: installHint(p) };
}

/** What a failed connection actually was, for the pull proxy's error payload. The client branches on
 *  this tag; the prose is for the person reading it. Node reports the syscall failure on `cause`. */
export type PullFailureReason = 'not-installed' | 'not-running' | 'unreachable';

export function classifyConnectionError(err: unknown, state: OllamaState): PullFailureReason {
  if (state.state === 'absent') return 'not-installed';
  if (state.state === 'stopped') return 'not-running';
  // The daemon answered /api/tags a moment ago but refused the pull — a genuine transport oddity
  // (firewall on POST, proxy, the daemon dying mid-probe) rather than a missing install.
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  return code === 'ECONNREFUSED' ? 'not-running' : 'unreachable';
}
