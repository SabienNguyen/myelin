// The environment tier: exec exercises whose program talks to a REAL SERVICE — a Redis to cache
// into, a Postgres to query — brought up with docker compose for the duration of one suite run
// and torn down after, win or lose.
//
// Scope, stated the way every tier here states it:
//
//  - Environments come from a VETTED REGISTRY, not from model-authored compose files. The model
//    authors the exercise (statement, reference, cases); the infrastructure it runs against is
//    fixed, reviewed YAML in this file. A generated exercise that could declare arbitrary images,
//    volumes and ports would be a supply-chain problem wearing a homework costume.
//  - The learner's program runs LOCALLY (any of the registered runtimes) and reaches the service
//    through a published port handed over in an environment variable (REDIS_URL, DATABASE_URL).
//    That keeps all runtimes usable — a Python learner does not need their program containerized
//    to talk to a composed Redis.
//  - Same honesty policy as container runtimes: images are NEVER pulled implicitly, and an
//    unavailable environment reports the reason WITH the fix (install Docker / start the daemon /
//    the exact docker pull). Grading a suite must never silently start a download.
//  - Determinism stays the exercise author's burden, enforced by the existing gates: a reference
//    that depends on wall clock or leftover state fails its own suite at verification time,
//    because every run gets a FRESH environment (down -v between runs, no reuse).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface EnvironmentSpec {
  id: string;
  /** The single service the learner's program talks to. */
  image: string;
  service: string;
  containerPort: number;
  /** Name of the env var handed to the learner's program, and how its value is built. */
  envVar: string;
  urlFor: (hostPort: number) => string;
  /** One line for prompts and UI: what is running and how to reach it. */
  blurb: string;
}

export const ENVIRONMENTS: EnvironmentSpec[] = [
  {
    id: 'redis',
    image: 'redis:7-alpine',
    service: 'redis',
    containerPort: 6379,
    envVar: 'REDIS_URL',
    urlFor: (p) => `redis://127.0.0.1:${p}`,
    blurb: 'a fresh Redis 7, reachable at $REDIS_URL',
  },
  {
    id: 'postgres',
    image: 'postgres:16-alpine',
    service: 'postgres',
    containerPort: 5432,
    envVar: 'DATABASE_URL',
    urlFor: (p) => `postgres://postgres:learn@127.0.0.1:${p}/postgres`,
    blurb: 'a fresh PostgreSQL 16 (user postgres, password learn, db postgres), reachable at $DATABASE_URL',
  },
];

export const environmentFor = (id: string): EnvironmentSpec | undefined =>
  ENVIRONMENTS.find((e) => e.id === id);

/** The compose file for one environment — pure, so a test can pin exactly what infrastructure an
 *  exercise is allowed to bring up. Host port 0 = ephemeral; discovered after `up` via
 *  `docker compose port`, so parallel runs never fight over a fixed port. */
export function composeFileFor(env: EnvironmentSpec): string {
  const health = env.id === 'postgres'
    ? '    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U postgres"]\n      interval: 1s\n      retries: 30\n'
    : '    healthcheck:\n      test: ["CMD", "redis-cli", "ping"]\n      interval: 1s\n      retries: 30\n';
  const extraEnv = env.id === 'postgres'
    ? '    environment:\n      POSTGRES_PASSWORD: learn\n'
    : '';
  return `services:\n  ${env.service}:\n    image: ${env.image}\n    ports:\n      - "0:${env.containerPort}"\n${extraEnv}${health}`;
}

export interface EnvironmentStatus { id: string; available: boolean; reason?: string }

function probe(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', () => resolve({ ok: false, stdout: '' }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout }));
  });
}

/** Deliberately uncached for the daemon/image cases — those are exactly what a user fixes
 *  mid-session (same reasoning as exec.ts's runtimeStatus). */
export async function environmentStatus(id: string): Promise<EnvironmentStatus> {
  const env = environmentFor(id);
  if (!env) return { id, available: false, reason: `unknown environment "${id}"` };
  if (!(await probe('docker', ['--version'])).ok) {
    return { id, available: false, reason: `the ${id} environment needs Docker, and Docker is not installed` };
  }
  if (!(await probe('docker', ['compose', 'version'])).ok) {
    return { id, available: false, reason: `the ${id} environment needs the docker compose plugin, which is not installed` };
  }
  if (!(await probe('docker', ['info'])).ok) {
    return { id, available: false, reason: `the ${id} environment needs Docker, and the daemon is not running — start Docker and try again` };
  }
  if (!(await probe('docker', ['image', 'inspect', env.image])).ok) {
    return { id, available: false, reason: `the ${env.image} image is not present — run: docker pull ${env.image}` };
  }
  return { id, available: true };
}

export async function environmentStatuses(): Promise<EnvironmentStatus[]> {
  return Promise.all(ENVIRONMENTS.map((e) => environmentStatus(e.id)));
}

const UP_TIMEOUT_MS = 60_000;

function runCompose(args: string[], cwd: string, timeoutMs = UP_TIMEOUT_MS): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['compose', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok: boolean) => { if (!settled) { settled = true; clearTimeout(killer); resolve({ ok, stdout, stderr }); } };
    const killer = setTimeout(() => { child.kill('SIGKILL'); finish(false); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

/**
 * Bring the environment up, hand `fn` the env vars the learner's program gets, and ALWAYS tear
 * down — `down -v` in the finally, so no volume outlives its run and no state leaks between
 * attempts. Distinct project name per invocation: two suite runs can overlap without sharing a
 * database.
 */
export async function withEnvironment<T>(
  id: string,
  fn: (envVars: Record<string, string>) => Promise<T>,
): Promise<T> {
  const env = environmentFor(id);
  if (!env) throw new Error(`unknown environment "${id}"`);
  const status = await environmentStatus(id);
  if (!status.available) throw new Error(status.reason ?? `${id} environment unavailable`);

  const dir = mkdtempSync(join(tmpdir(), 'lwh-env-'));
  const project = `lwh-${id}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(join(dir, 'compose.yaml'), composeFileFor(env));
  const up = await runCompose(['-p', project, 'up', '-d', '--wait'], dir);
  try {
    if (!up.ok) {
      throw new Error(`the ${id} environment failed to start: ${(up.stderr || up.stdout).trim().slice(-400)}`);
    }
    // Discover the ephemeral host port ("0.0.0.0:49153" or "[::]:49153" — take the last colon).
    const port = await runCompose(['-p', project, 'port', env.service, String(env.containerPort)], dir);
    const hostPort = Number(port.stdout.trim().split(':').pop());
    if (!port.ok || !Number.isFinite(hostPort) || hostPort <= 0) {
      throw new Error(`could not discover the ${id} environment's published port`);
    }
    return await fn({ [env.envVar]: env.urlFor(hostPort) });
  } finally {
    await runCompose(['-p', project, 'down', '-v', '--timeout', '5'], dir); // best-effort; runCompose never rejects
    rmSync(dir, { recursive: true, force: true });
  }
}
