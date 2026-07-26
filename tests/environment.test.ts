// The environment tier — composed services for exec exercises. This dev environment has the
// docker CLI but no reachable daemon, so the tested paths are the vetted registry, the pinned
// compose files, the reason-with-fix availability answers, and the refusal paths — the states a
// learner actually hits when Docker is absent or half-configured. The live up/run/down lifecycle
// needs a machine with a running daemon; withEnvironment's contract (fresh env per run, down -v
// in the finally, ephemeral ports) is specified here by the pinned compose + argv shapes.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import {
  ENVIRONMENTS, composeFileFor, environmentFor, environmentStatus, withEnvironment,
} from '../src/server/gap/environment.js';
import { generateExercise } from '../src/server/gap/generated.js';

describe('the vetted registry', () => {
  it('contains exactly the reviewed environments — model-authored compose files are not a thing', () => {
    expect(ENVIRONMENTS.map((e) => e.id)).toEqual(['redis', 'postgres']);
  });

  it('every compose file parses, publishes an EPHEMERAL port, and has a healthcheck', () => {
    for (const env of ENVIRONMENTS) {
      const doc = load(composeFileFor(env)) as any;
      const svc = doc.services[env.service];
      expect(svc.image).toBe(env.image);
      expect(svc.ports).toEqual([`0:${env.containerPort}`]); // 0 = never fight over a fixed port
      expect(svc.healthcheck).toBeDefined(); // --wait needs a health signal to wait ON
    }
  });

  it('connection strings come from urlFor with the discovered port', () => {
    expect(environmentFor('redis')!.urlFor(49153)).toBe('redis://127.0.0.1:49153');
    expect(environmentFor('postgres')!.urlFor(50000)).toContain(':50000/postgres');
  });
});

describe('availability and refusal', () => {
  it('an unknown environment is a loud error', async () => {
    const status = await environmentStatus('mongodb');
    expect(status.available).toBe(false);
    expect(status.reason).toContain('unknown environment');
    await expect(withEnvironment('mongodb', async () => 0)).rejects.toThrow(/unknown environment/);
  });

  it('an unavailable environment says WHY, with the fix where there is one', async () => {
    const status = await environmentStatus('redis');
    if (status.available) return; // a machine with live Docker + image: nothing to refuse
    expect(status.reason).toMatch(/Docker is not installed|compose plugin|daemon is not running|docker pull/);
  });

  it('withEnvironment surfaces the status reason instead of a generic failure', async () => {
    const status = await environmentStatus('postgres');
    if (status.available) return;
    await expect(withEnvironment('postgres', async () => 0)).rejects.toThrow(status.reason!);
  });
});

describe('generation guards', () => {
  let vault: string;
  beforeEach(() => { vault = mkdtempSync(join(tmpdir(), 'lwh-envgen-')); });
  const stub = async () => JSON.stringify({ title: 'x', statement: 'y', reference: '', cases: [], prose: {} });

  it('an environment on a non-exec family is refused outright', async () => {
    await expect(generateExercise(vault, 'p', '', { generate: stub }, 'function', undefined, 'redis'))
      .rejects.toThrow(/only apply to the exec family/);
  });

  it('an unknown environment is refused before any model call', async () => {
    await expect(generateExercise(vault, 'p', '', { generate: stub }, 'exec', 'node', 'mongodb'))
      .rejects.toThrow(/unknown environment/);
  });

  it('an unavailable environment fails loudly with the fix', async () => {
    const status = await environmentStatus('redis');
    if (status.available) return; // live Docker: generation would proceed to the gates
    await expect(generateExercise(vault, 'p', '', { generate: stub }, 'exec', 'node', 'redis'))
      .rejects.toThrow(status.reason!);
  });
});
