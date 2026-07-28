// The manifest family — Kubernetes-style write-from-spec practice, graded by mechanical
// assertions over parsed YAML. Same defence as every family: the gates must reject a suite that
// grades nothing, and the reference must actually satisfy its own assertions.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gradeManifest, resolvePath, scratchManifest, type ManifestAssertion } from '../src/server/gap/manifest.js';
import { generateExercise, setGeneratedStatus, verifyExercise } from '../src/server/gap/generated.js';
import { buildBuiltinGapRoutes, builtinPatterns } from '../src/server/gap/service.js';

const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: nginx
          image: nginx:1.25.3
          ports:
            - containerPort: 80
`;

const ASSERTIONS: ManifestAssertion[] = [
  { name: 'it is a Deployment', path: 'kind', op: 'eq', value: 'Deployment' },
  { name: 'named as the task asks', path: 'metadata.name', op: 'eq', value: 'web' },
  { name: 'runs the requested number of replicas', path: 'spec.replicas', op: 'eq', value: 3 },
  { name: 'selector agrees with the pod labels', path: 'spec.selector.matchLabels.app', op: 'eq', value: 'web' },
  { name: 'uses the pinned image', path: 'spec.template.spec.containers[0].image', op: 'matches', value: '^nginx:1\\.25' },
  { name: 'exposes the container port', path: 'spec.template.spec.containers[0].ports[0].containerPort', op: 'eq', value: 80 },
];

describe('resolvePath', () => {
  const doc = { a: { b: [{ c: 1 }, { c: 2 }] }, n: null };
  it('walks dots and [n]', () => {
    expect(resolvePath(doc, 'a.b[1].c')).toEqual({ found: true, value: 2 });
  });
  it('distinguishes null from missing', () => {
    expect(resolvePath(doc, 'n')).toEqual({ found: true, value: null });
    expect(resolvePath(doc, 'missing.path')).toEqual({ found: false });
  });
  it('addresses a dotted/slashed key via a bracket-quoted segment (K8s recommended labels)', () => {
    const k8s = { metadata: { labels: { 'app.kubernetes.io/name': 'web', tier: 'frontend' } } };
    // Plain dot-splitting would look for metadata.labels.app.kubernetes.io/name and miss.
    expect(resolvePath(k8s, "metadata.labels['app.kubernetes.io/name']")).toEqual({ found: true, value: 'web' });
    expect(resolvePath(k8s, 'metadata.labels["tier"]')).toEqual({ found: true, value: 'frontend' });
    expect(resolvePath(k8s, "metadata.labels['absent.io/x']")).toEqual({ found: false });
  });
});

describe('gradeManifest', () => {
  it('passes a correct manifest on all assertions', () => {
    const out = gradeManifest(DEPLOYMENT, ASSERTIONS);
    expect(out.pass).toBe(true);
    expect(out.results).toHaveLength(6);
  });

  it('fails the right assertion with expected/actual only on the miss', () => {
    const wrong = DEPLOYMENT.replace('replicas: 3', 'replicas: 2');
    const out = gradeManifest(wrong, ASSERTIONS);
    expect(out.pass).toBe(false);
    const miss = out.results.find((r) => !r.pass)!;
    expect(miss.name).toBe('runs the requested number of replicas');
    expect(miss.expected).toBe('3');
    expect(miss.actual).toBe('2');
    expect(out.results.filter((r) => r.pass).every((r) => r.expected === undefined)).toBe(true);
  });

  it('reports a parse error in syntaxError, like a JS syntax error', () => {
    const out = gradeManifest('kind: [unclosed', ASSERTIONS);
    expect(out.pass).toBe(false);
    expect(out.syntaxError).toContain('YAML did not parse');
  });

  it('absent and multi-document addressing work', () => {
    const two = `kind: Service\n---\nkind: Deployment\nspec:\n  replicas: 1\n`;
    const out = gradeManifest(two, [
      { name: 'first doc is the Service', path: 'kind', op: 'eq', value: 'Service' },
      { name: 'second doc is the Deployment', path: 'docs[1].kind', op: 'eq', value: 'Deployment' },
      { name: 'no hostNetwork anywhere in doc 1', path: 'docs[1].spec.hostNetwork', op: 'absent' },
    ]);
    expect(out.pass).toBe(true);
  });

  it('scratch returns the parsed document and never an assertion', () => {
    const out = scratchManifest('a: 1\nb:\n  - x\n');
    expect(out.scratch).toBe(true);
    expect(JSON.parse(out.actual!)).toEqual({ a: 1, b: ['x'] });
  });
});

describe('manifest verification gates', () => {
  const EXERCISE = {
    entryPoint: 'manifest',
    statement: 'Create a Deployment named web with 3 replicas of nginx:1.25.3 exposing port 80.',
    reference: DEPLOYMENT,
    cases: ASSERTIONS,
    family: 'manifest' as const,
  };

  it('admits a real manifest exercise', async () => {
    const report = await verifyExercise(EXERCISE);
    expect(report.gates.map((g) => `${g.ok ? '+' : '-'}${g.gate}`)).toEqual([
      '+suite-size', '+reference-passes', '+rejects-empty-implementation',
      '+scaffold-does-not-pass', '+names-do-not-leak-answers',
    ]);
    expect(report.ok).toBe(true);
  });

  it('REJECTS an all-absent suite — an empty file would pass it', async () => {
    const vacuous = {
      ...EXERCISE,
      cases: [
        { name: 'a', path: 'spec.hostNetwork', op: 'absent' as const },
        { name: 'b', path: 'spec.hostPID', op: 'absent' as const },
        { name: 'c', path: 'spec.hostIPC', op: 'absent' as const },
      ],
    };
    const report = await verifyExercise(vacuous);
    expect(report.ok).toBe(false);
    expect(report.gates.find((g) => g.gate === 'rejects-empty-implementation')?.ok).toBe(false);
  });

  it('rejects a reference that does not satisfy its own assertions', async () => {
    const broken = { ...EXERCISE, reference: DEPLOYMENT.replace('replicas: 3', 'replicas: 5') };
    const report = await verifyExercise(broken);
    expect(report.ok).toBe(false);
    expect(report.gates.find((g) => g.gate === 'reference-passes')?.ok).toBe(false);
  });
});

describe('manifest exercises through the service', () => {
  let vault: string;
  beforeEach(() => { vault = mkdtempSync(join(tmpdir(), 'lwh-manifest-')); });

  const stub = async () => JSON.stringify({
    title: 'Deploy the web tier',
    statement: 'Create a Deployment named web with 3 replicas of nginx:1.25.3 exposing port 80.',
    reference: DEPLOYMENT,
    cases: ASSERTIONS,
    prose: { context_line: 'Exam-style.', hint: 'Selector must match pod labels.', success_line: 'Done.' },
  });

  it('generate -> approve -> ladder/run/scratch, manifest family end to end', async () => {
    await generateExercise(vault, 'cka-web-deployment', 'CKA prep', { generate: stub }, 'manifest');
    setGeneratedStatus(vault, 'cka-web-deployment', 'approved');
    expect(builtinPatterns(vault)).toContain('cka-web-deployment');

    const app = buildBuiltinGapRoutes({ vault });
    const ladder = await (await app.request('/api/gap/ladder?pattern=cka-web-deployment')).json();
    expect(ladder.family).toBe('manifest');
    expect(ladder.rungs[0].reference_answer).toBe('');
    expect(ladder.rungs[0].predict).toEqual([]); // nothing to predict — assertions are the grade
    expect(ladder.rungs[0].scaffold).toContain('# YOUR TURN');

    const run = await (await app.request('/api/gap/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'cka-web-deployment:full_body', code: DEPLOYMENT }),
    })).json();
    expect(run.pass).toBe(true);
    expect(run.results).toHaveLength(6);

    const missing = await (await app.request('/api/gap/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'cka-web-deployment:full_body', code: 'kind: Deployment\n' }),
    })).json();
    expect(missing.pass).toBe(false);

    const scratch = await (await app.request('/api/gap/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'cka-web-deployment:full_body', code: 'kind: Pod\n', input: '' }),
    })).json();
    expect(scratch.scratch).toBe(true);
    expect(JSON.parse(scratch.actual)).toEqual({ kind: 'Pod' });

    // Stress must not pretend: no `stressed` flag for a manifest run.
    const stress = await (await app.request('/api/gap/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'cka-web-deployment:full_body', code: DEPLOYMENT, stress: true }),
    })).json();
    expect(stress.stressed).toBeUndefined();
    expect(stress.pass).toBe(true);
  });
});
