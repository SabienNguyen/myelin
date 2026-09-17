// The cluster exercise family: a REAL Kubernetes sandbox. The harness sets up a situation in a
// live cluster (a Deployment whose image tag does not exist, a Service selecting nothing), the
// learner fixes it with kubectl in their own terminal, and the grade is read back from cluster
// state — the manifest family next door only checks what a YAML file SAYS.
//
// The cost model drives the design. `kind create cluster` takes a minute or more; a namespace
// takes about a second. So there is ONE long-lived cluster, created the first time any cluster
// exercise is opened and reused for every one after, and each exercise gets a namespace that is
// cheap to create, cheap to reset and cheap to throw away.
//
// The cluster is the app's own (`myelin`), with its own kubeconfig file under the vault. Nothing
// here reads or writes ~/.kube/config or names any other cluster: a learner prepping for the CKA
// has practice clusters of their own, and model-written setup must never land in one.

import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadAll } from 'js-yaml';
import { assertOn, type ManifestAssertion } from './manifest.js';
import type { RunnerResult } from './runner.js';

export const CLUSTER_NAME = 'myelin';

/** `target` is what kubectl reads ("deployment/web", "pod/api-0"); `path` then resolves inside
 *  that object exactly as a manifest assertion resolves inside a YAML document. */
export interface ClusterAssertion extends ManifestAssertion { target: string }

export type Exec = (
  cmd: string, args: string[], opts?: { stdin?: string; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface ClusterDeps {
  kubeconfig: string;
  /** Injected in tests; production shells out with argv arrays (no shell, like the rest of gap/). */
  exec?: Exec;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const kubeconfigFor = (vault: string) => join(vault, '.harness', 'kube', `${CLUSTER_NAME}.kubeconfig`);

const realExec: Exec = (cmd, args, opts = {}) => new Promise((resolve) => {
  const child = execFile(cmd, args, { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => {
      // ENOENT (binary missing) and a kill-on-timeout both arrive as `err` with no exit code.
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      resolve({ code, stdout, stderr: stderr || (err && code === 1 ? err.message : '') });
    });
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
});

const run = (deps: ClusterDeps) => deps.exec ?? realExec;
const kubectl = (deps: ClusterDeps, args: string[], opts?: { stdin?: string; timeoutMs?: number }) =>
  run(deps)('kubectl', ['--kubeconfig', deps.kubeconfig, ...args], opts);

/** Can this machine host the sandbox at all? The reason carries the fix, like runtimeStatus. */
export async function clusterStatus(exec: Exec = realExec): Promise<{ available: boolean; reason?: string }> {
  for (const [cmd, args, fix] of [
    ['kind', ['version'], 'install kind (https://kind.sigs.k8s.io) — it runs the sandbox cluster inside Docker'],
    ['kubectl', ['version', '--client'], 'install kubectl'],
    ['docker', ['info', '--format', '{{.ServerVersion}}'], 'start the Docker daemon — kind runs the cluster as a container'],
  ] as const) {
    const out = await exec(cmd, [...args], { timeoutMs: 10_000 });
    if (out.code !== 0) return { available: false, reason: `${cmd} is not usable here: ${fix}` };
  }
  return { available: true };
}

// kubeconfig path -> the in-flight or finished bring-up. Single-flight: five exercises opened at
// once share one `kind create`. A FAILURE is evicted so the next attempt is a real one — Docker
// being down at 9am must not mean no sandbox until the server restarts.
const ready = new Map<string, Promise<void>>();
export function resetClusterMemo(): void { ready.clear(); }

export function ensureCluster(deps: ClusterDeps): Promise<void> {
  const existing = ready.get(deps.kubeconfig);
  if (existing) return existing;
  const bringUp = (async () => {
    const exec = run(deps);
    mkdirSync(dirname(deps.kubeconfig), { recursive: true });
    const list = await exec('kind', ['get', 'clusters'], { timeoutMs: 20_000 });
    if (list.code !== 0) throw new Error(`could not list kind clusters: ${list.stderr.trim()}`);
    if (list.stdout.split('\n').map((l) => l.trim()).includes(CLUSTER_NAME)) {
      // Already built (an earlier run, or before a restart). The kubeconfig file may be gone or
      // stale — the API server's port changes when Docker restarts the node — so rewrite it.
      const exp = await exec('kind', ['export', 'kubeconfig', '--name', CLUSTER_NAME, '--kubeconfig', deps.kubeconfig], { timeoutMs: 30_000 });
      if (exp.code !== 0) throw new Error(`could not read the ${CLUSTER_NAME} cluster's kubeconfig: ${exp.stderr.trim()}`);
      return;
    }
    console.log(`[cluster] creating the ${CLUSTER_NAME} kind cluster — once; every later exercise reuses it`);
    const created = await exec('kind',
      ['create', 'cluster', '--name', CLUSTER_NAME, '--kubeconfig', deps.kubeconfig, '--wait', '180s'],
      { timeoutMs: 300_000 });
    if (created.code !== 0) throw new Error(`kind could not create the sandbox cluster: ${created.stderr.trim()}`);
  })();
  ready.set(deps.kubeconfig, bringUp);
  bringUp.catch(() => ready.delete(deps.kubeconfig));
  return bringUp;
}

// What a namespace can hold and its deletion cleans up. An allowlist, not a denylist: a kind this
// list has never heard of is refused rather than guessed at.
const NAMESPACED_KINDS = new Set([
  'Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob',
  'Service', 'Endpoints', 'Ingress', 'NetworkPolicy',
  'ConfigMap', 'Secret', 'ServiceAccount', 'Role', 'RoleBinding',
  'PersistentVolumeClaim', 'HorizontalPodAutoscaler', 'PodDisruptionBudget', 'ResourceQuota', 'LimitRange',
]);

function parseDocs(yamlText: string): Record<string, any>[] {
  return loadAll(yamlText).filter((d): d is Record<string, any> => d !== null && typeof d === 'object');
}

/** Null when every document is a namespaced kind that does not name a namespace of its own;
 *  otherwise the reason. Applied to MODEL-written YAML (setup and reference) before it goes near
 *  the cluster — `kubectl apply -n ns` does not stop a document that says `namespace: kube-system`
 *  or a ClusterRoleBinding, and namespace deletion would never clean either up. */
export function validateNamespaced(yamlText: string): string | null {
  let docs: Record<string, any>[];
  try {
    docs = parseDocs(yamlText);
  } catch (e) {
    return `YAML did not parse: ${e instanceof Error ? e.message : String(e)}`;
  }
  for (const d of docs) {
    if (!NAMESPACED_KINDS.has(String(d.kind))) {
      return `kind ${String(d.kind)} is not allowed in a sandbox namespace (only namespaced workload kinds are)`;
    }
    if (d.metadata?.namespace !== undefined) {
      return `${d.kind}/${d.metadata?.name ?? '?'} names its own namespace (${d.metadata.namespace}); the sandbox assigns one`;
    }
  }
  return null;
}

/** DNS-1123, at most 63 chars, and deterministic: the namespace IS the session, so a learner's
 *  half-fixed sandbox is still there after the server restarts. */
export function sessionNamespace(pattern: string): string {
  const slug = pattern.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `mx-${slug}`.slice(0, 63).replace(/-+$/, '');
}

export async function namespaceExists(deps: ClusterDeps, ns: string): Promise<boolean> {
  return (await kubectl(deps, ['get', 'namespace', ns, '-o', 'name'], { timeoutMs: 20_000 })).code === 0;
}

export async function openNamespace(deps: ClusterDeps, ns: string, setupYaml: string): Promise<void> {
  // baseline pod security: a kind node is a privileged container on the host, so a pod that is
  // privileged or mounts hostPath is one step from the learner's machine. Setup is model-written.
  const manifest = `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}\n  labels:\n`
    + `    pod-security.kubernetes.io/enforce: baseline\n    app.kubernetes.io/managed-by: ${CLUSTER_NAME}\n`;
  const made = await kubectl(deps, ['apply', '-f', '-'], { stdin: manifest, timeoutMs: 30_000 });
  if (made.code !== 0) throw new Error(`could not create namespace ${ns}: ${made.stderr.trim()}`);
  await applyInto(deps, ns, setupYaml);
}

/** Apply YAML into the namespace. A file with no documents — the untouched scaffold, all comments —
 *  applies nothing: that learner did the work with kubectl, and the check reads the cluster. */
export async function applyInto(deps: ClusterDeps, ns: string, yamlText: string): Promise<void> {
  let docs: unknown[];
  try {
    docs = parseDocs(yamlText);
  } catch (e) {
    throw new Error(`YAML did not parse: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (docs.length === 0) return;
  const out = await kubectl(deps, ['apply', '-n', ns, '-f', '-'], { stdin: yamlText, timeoutMs: 60_000 });
  if (out.code !== 0) throw new Error(out.stderr.trim() || 'kubectl apply failed');
}

export async function deleteNamespace(deps: ClusterDeps, ns: string, wait = false): Promise<void> {
  const out = await kubectl(deps, ['delete', 'namespace', ns, '--ignore-not-found', `--wait=${wait}`],
    { timeoutMs: wait ? 120_000 : 30_000 });
  if (out.code !== 0) console.error(`[cluster] could not delete namespace ${ns}: ${out.stderr.trim()}`);
}

const POLL_MS = 2_000;

/** Grade live state. Each distinct target is read once per pass; the pass repeats until everything
 *  holds or `timeoutMs` runs out, because a rollout is not instant and a correct fix must not grade
 *  as wrong for its first few seconds. `timeoutMs: 0` is a single look. */
export async function checkCluster(
  deps: ClusterDeps, ns: string, assertions: ClusterAssertion[], timeoutMs: number,
): Promise<RunnerResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const now = deps.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    const objects = new Map<string, unknown>();
    for (const target of new Set(assertions.map((a) => a.target))) {
      const got = await kubectl(deps, ['get', target, '-n', ns, '-o', 'json'], { timeoutMs: 20_000 });
      if (got.code !== 0) { objects.set(target, undefined); continue; }
      try {
        objects.set(target, JSON.parse(got.stdout));
      } catch {
        return { pass: false, results: [], syntaxError: `kubectl returned unreadable JSON for ${target}` };
      }
    }
    const results = assertions.map((a) => {
      const obj = objects.get(a.target);
      const row = assertOn(obj, a.path, a, `${a.target} ${a.path}`);
      if (!row.pass && obj === undefined) row.actual = `${a.target} not found`;
      return row;
    });
    const pass = results.every((r) => r.pass);
    if (pass || now() + POLL_MS > deadline) {
      return { pass, results, trace: { fired: results.filter((r) => r.pass).map((r) => r.name) } };
    }
    await sleep(POLL_MS);
  }
}

/** One gate run: a throwaway namespace with the setup applied, handed to `fn`, then deleted —
 *  never the learner's session namespace, so verifying an exercise cannot disturb work in progress. */
export async function withScratchNamespace<T>(
  deps: ClusterDeps, setupYaml: string, fn: (ns: string) => Promise<T>,
): Promise<T> {
  const ns = `mx-verify-${Math.random().toString(36).slice(2, 10)}`;
  await ensureCluster(deps);
  try {
    await openNamespace(deps, ns, setupYaml);
    return await fn(ns);
  } finally {
    await deleteNamespace(deps, ns);
  }
}
