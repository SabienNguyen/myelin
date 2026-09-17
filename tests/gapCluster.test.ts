// The cluster sandbox, tested with no cluster: every command goes through an injected `exec`, so
// these pin WHAT is run (argv, stdin, order) and what the grader makes of the JSON that comes back.
// The real-cluster path is covered by the live drive, not here — CI has no Docker-in-Docker.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLUSTER_NAME, applyInto, checkCluster, ensureCluster, openNamespace, resetClusterMemo,
  sessionNamespace, validateNamespaced, type ClusterAssertion, type Exec,
} from '../src/server/gap/cluster.js';

type Call = { cmd: string; args: string[]; stdin?: string };
type Reply = { code?: number; stdout?: string; stderr?: string };

function fakeExec(reply: (c: Call) => Reply | undefined) {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    const call = { cmd, args, stdin: opts?.stdin };
    calls.push(call);
    const r = reply(call) ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { exec, calls };
}
const line = (c: Call) => `${c.cmd} ${c.args.join(' ')}`;
const KUBECONFIG = join(mkdtempSync(join(tmpdir(), 'mx-cluster-')), 'kube', 'myelin.kubeconfig');

describe('ensureCluster — build once, reuse', () => {
  it('creates the cluster when it is missing, with its OWN kubeconfig', async () => {
    resetClusterMemo();
    const { exec, calls } = fakeExec((c) => (line(c) === 'kind get clusters' ? { stdout: 'cka-main\ncka-alt\n' } : undefined));
    await ensureCluster({ exec, kubeconfig: KUBECONFIG });
    const create = calls.find((c) => c.args[0] === 'create');
    expect(create?.args).toEqual(['create', 'cluster', '--name', CLUSTER_NAME, '--kubeconfig', KUBECONFIG, '--wait', '180s']);
  });

  it('never touches the learner\'s other clusters or ~/.kube/config', async () => {
    resetClusterMemo();
    const { exec, calls } = fakeExec((c) => (line(c) === 'kind get clusters' ? { stdout: 'cka-main\n' } : undefined));
    await ensureCluster({ exec, kubeconfig: KUBECONFIG });
    for (const c of calls.filter((k) => k.cmd === 'kind' && k.args[0] !== 'get')) {
      expect(c.args).toContain(CLUSTER_NAME);
      expect(c.args).toContain(KUBECONFIG);
    }
    expect(calls.some((c) => c.args.includes('cka-main'))).toBe(false);
  });

  it('reuses an existing cluster: no create, just a refreshed kubeconfig', async () => {
    resetClusterMemo();
    const { exec, calls } = fakeExec((c) => (line(c) === 'kind get clusters' ? { stdout: `cka-main\n${CLUSTER_NAME}\n` } : undefined));
    await ensureCluster({ exec, kubeconfig: KUBECONFIG });
    expect(calls.some((c) => c.args[0] === 'create')).toBe(false);
    expect(calls.map(line)).toContain(`kind export kubeconfig --name ${CLUSTER_NAME} --kubeconfig ${KUBECONFIG}`);
  });

  // The slow part is the point of the whole design: five exercises opened at once must cost one
  // cluster, not five racing `kind create`s.
  it('is single-flight — concurrent callers share one creation, later callers pay nothing', async () => {
    resetClusterMemo();
    const { exec, calls } = fakeExec((c) => (line(c) === 'kind get clusters' ? { stdout: '' } : undefined));
    await Promise.all([1, 2, 3].map(() => ensureCluster({ exec, kubeconfig: KUBECONFIG })));
    await ensureCluster({ exec, kubeconfig: KUBECONFIG });
    expect(calls.filter((c) => c.args[0] === 'create')).toHaveLength(1);
  });

  it('a failed creation is not remembered — the next exercise gets to try again', async () => {
    resetClusterMemo();
    let attempts = 0;
    const { exec } = fakeExec((c) => {
      if (line(c) === 'kind get clusters') return { stdout: '' };
      if (c.args[0] === 'create') { attempts += 1; return attempts === 1 ? { code: 1, stderr: 'docker daemon not running' } : {}; }
      return undefined;
    });
    await expect(ensureCluster({ exec, kubeconfig: KUBECONFIG })).rejects.toThrow(/docker daemon not running/);
    await expect(ensureCluster({ exec, kubeconfig: KUBECONFIG })).resolves.toBeUndefined();
  });
});

describe('validateNamespaced — model-written YAML stays inside its namespace', () => {
  const doc = (kind: string, extra = '') => `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: x\n${extra}`;
  it('accepts ordinary namespaced workloads', () => {
    expect(validateNamespaced(`${doc('Deployment')}---\n${doc('Service')}---\n${doc('ConfigMap')}`)).toBeNull();
  });
  it('refuses cluster-scoped kinds, which a namespace cannot contain or clean up', () => {
    expect(validateNamespaced(doc('ClusterRoleBinding'))).toMatch(/ClusterRoleBinding/);
    expect(validateNamespaced(doc('Namespace'))).toMatch(/Namespace/);
    expect(validateNamespaced(doc('PersistentVolume'))).toMatch(/PersistentVolume/);
  });
  it('refuses a document that names a different namespace', () => {
    expect(validateNamespaced(doc('Pod', '  namespace: kube-system\n'))).toMatch(/kube-system/);
  });
  it('reports YAML that does not parse instead of applying it', () => {
    expect(validateNamespaced('kind: [unclosed')).toMatch(/did not parse/);
  });
});

describe('openNamespace / applyInto', () => {
  it('creates the namespace under the baseline pod-security profile, then applies the setup into it', async () => {
    const { exec, calls } = fakeExec(() => undefined);
    await openNamespace({ exec, kubeconfig: KUBECONFIG }, 'mx-demo', 'kind: ConfigMap\nmetadata:\n  name: a\n');
    const created = calls.find((c) => c.args.includes('apply') && c.stdin?.includes('kind: Namespace'));
    // baseline refuses privileged pods, hostPath, hostNetwork and hostPID: a kind node is itself a
    // privileged container, so without this a generated setup is one hostPath away from the host.
    expect(created?.stdin).toContain('pod-security.kubernetes.io/enforce: baseline');
    const applied = calls.find((c) => c.stdin?.includes('kind: ConfigMap'));
    expect(applied?.args).toEqual(['--kubeconfig', KUBECONFIG, 'apply', '-n', 'mx-demo', '-f', '-']);
  });

  it('applies nothing for a comment-only file — the learner worked in their terminal', async () => {
    const { exec, calls } = fakeExec(() => undefined);
    await applyInto({ exec, kubeconfig: KUBECONFIG }, 'mx-demo', '# task text\n# YOUR TURN\n');
    expect(calls).toEqual([]);
  });

  it('surfaces kubectl\'s own error text when an apply is rejected', async () => {
    const { exec } = fakeExec(() => ({ code: 1, stderr: 'error: unable to recognize "STDIN": no matches for kind "Deploymnt"' }));
    await expect(applyInto({ exec, kubeconfig: KUBECONFIG }, 'mx-demo', 'kind: Deploymnt\nmetadata:\n  name: a\n'))
      .rejects.toThrow(/no matches for kind "Deploymnt"/);
  });
});

describe('checkCluster — graded on live state, not on what a file says', () => {
  const live = (o: object) => ({ stdout: JSON.stringify(o) });
  const assertions: ClusterAssertion[] = [
    { name: 'three replicas requested', target: 'deployment/web', path: 'spec.replicas', op: 'eq', value: 3 },
    { name: 'all three are ready', target: 'deployment/web', path: 'status.readyReplicas', op: 'eq', value: 3 },
    { name: 'service selects the web pods', target: 'service/web', path: 'spec.selector.app', op: 'eq', value: 'web' },
  ];
  const deps = (exec: Exec) => ({ exec, kubeconfig: KUBECONFIG, sleep: async () => {} });

  it('reads each resource once per pass and grades every assertion against it', async () => {
    const { exec, calls } = fakeExec((c) => (c.args.includes('deployment/web')
      ? live({ spec: { replicas: 3 }, status: { readyReplicas: 3 } })
      : live({ spec: { selector: { app: 'web' } } })));
    const out = await checkCluster(deps(exec), 'mx-demo', assertions, 0);
    expect(out.pass).toBe(true);
    expect(calls).toHaveLength(2); // two targets, three assertions
    expect(calls[0].args).toEqual(['--kubeconfig', KUBECONFIG, 'get', 'deployment/web', '-n', 'mx-demo', '-o', 'json']);
  });

  it('a resource that does not exist fails its assertions and says so', async () => {
    const { exec } = fakeExec((c) => (c.args.includes('service/web')
      ? { code: 1, stderr: 'Error from server (NotFound): services "web" not found' }
      : live({ spec: { replicas: 3 }, status: { readyReplicas: 3 } })));
    const out = await checkCluster(deps(exec), 'mx-demo', assertions, 0);
    expect(out.pass).toBe(false);
    const row = out.results.find((r) => r.name === 'service selects the web pods')!;
    expect(row.pass).toBe(false);
    expect(row.actual).toMatch(/service\/web not found/);
  });

  it('"absent" passes for a resource that is gone — deleting the bad pod IS the fix', async () => {
    const { exec } = fakeExec(() => ({ code: 1, stderr: 'Error from server (NotFound): pods "crashloop" not found' }));
    const out = await checkCluster(deps(exec), 'mx-demo',
      [{ name: 'the crashing pod is removed', target: 'pod/crashloop', path: 'metadata.name', op: 'absent' }], 0);
    expect(out.pass).toBe(true);
  });

  // A rollout is not instant. Without this a correct fix grades as wrong for the first seconds.
  it('polls until the cluster converges, within the time allowed', async () => {
    let reads = 0;
    const { exec } = fakeExec((c) => {
      if (!c.args.includes('deployment/web')) return live({ spec: { selector: { app: 'web' } } });
      reads += 1;
      return live({ spec: { replicas: 3 }, status: { readyReplicas: reads >= 3 ? 3 : 1 } });
    });
    let clock = 0;
    const out = await checkCluster({ exec, kubeconfig: KUBECONFIG, sleep: async (ms) => { clock += ms; }, now: () => clock },
      'mx-demo', assertions, 30_000);
    expect(out.pass).toBe(true);
    expect(reads).toBe(3);
  });

  it('gives up at the deadline and reports the last state it saw', async () => {
    const { exec } = fakeExec((c) => (c.args.includes('deployment/web')
      ? live({ spec: { replicas: 3 }, status: { readyReplicas: 1 } })
      : live({ spec: { selector: { app: 'web' } } })));
    let clock = 0;
    const out = await checkCluster({ exec, kubeconfig: KUBECONFIG, sleep: async (ms) => { clock += ms; }, now: () => clock },
      'mx-demo', assertions, 5_000);
    expect(out.pass).toBe(false);
    expect(out.results.find((r) => r.name === 'all three are ready')).toMatchObject({ pass: false, actual: '1' });
  });
});

describe('sessionNamespace', () => {
  it('is deterministic, so a learner\'s sandbox survives a server restart', () => {
    expect(sessionNamespace('cka-fix-selector')).toBe('mx-cka-fix-selector');
  });
  it('stays a legal namespace name for a long or odd pattern id', () => {
    const ns = sessionNamespace(`Weird_Pattern.${'x'.repeat(80)}`);
    expect(ns).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(ns.length).toBeLessThanOrEqual(63);
  });
});

// ── the generator + gates, against a fake cluster whose state depends on what was applied ──────
import { generateExercise, generatedRungParts } from '../src/server/gap/generated.js';

const SETUP = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 2\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx:1.27-does-not-exist\n';
const FIX = SETUP.replace('nginx:1.27-does-not-exist', 'nginx:1.27-alpine');
const authored = (over: Record<string, unknown> = {}) => JSON.stringify({
  title: 'Pods never become ready',
  statement: 'The web Deployment in your namespace never becomes available.\nMake both replicas ready.',
  setup: SETUP, reference: FIX,
  cases: [
    { name: 'two replicas requested', target: 'deployment/web', path: 'spec.replicas', op: 'eq', value: 2 },
    { name: 'both replicas ready', target: 'deployment/web', path: 'status.readyReplicas', op: 'eq', value: 2 },
    { name: 'the deployment is available', target: 'deployment/web', path: 'status.availableReplicas', op: 'eq', value: 2 },
  ],
  prose: { context_line: 'c', hint: 'h', success_line: 's' },
  ...over,
});

/** A namespace is "fixed" once YAML carrying the good image has been applied into it. */
function fakeCluster() {
  const fixed = new Set<string>();
  const namespaces: string[] = [];
  const { exec, calls } = fakeExec((c) => {
    const ns = c.args[c.args.indexOf('-n') + 1];
    if (c.args.includes('apply') && c.stdin?.includes('kind: Namespace')) namespaces.push(/name: (\S+)/.exec(c.stdin)![1]);
    if (c.args.includes('apply') && c.stdin?.includes('nginx:1.27-alpine')) fixed.add(ns);
    if (c.args.includes('get') && c.args.includes('deployment/web')) {
      return { stdout: JSON.stringify({ spec: { replicas: 2 }, status: fixed.has(ns) ? { readyReplicas: 2, availableReplicas: 2 } : {} }) };
    }
    if (line(c) === 'kind get clusters') return { stdout: `${CLUSTER_NAME}\n` };
    return undefined;
  });
  let clock = 0;
  return { calls, namespaces, deps: { exec, kubeconfig: KUBECONFIG, sleep: async (ms: number) => { clock += ms; }, now: () => clock } };
}

describe('generateExercise — cluster family', () => {
  const vault = () => mkdtempSync(join(tmpdir(), 'mx-cluster-vault-'));

  it('approves an exercise whose setup fails the checks and whose fix passes them', async () => {
    resetClusterMemo();
    const cluster = fakeCluster();
    const ex = await generateExercise(vault(), 'cka-unready-pods', 'a bad image tag', { generate: async () => authored(), cluster: cluster.deps }, 'cluster');
    expect(ex.verification.gates.map((g) => `${g.ok ? 'PASS' : 'FAIL'} ${g.gate}`)).toEqual([
      'PASS suite-size', 'PASS stays-in-namespace', 'PASS reference-passes',
      'PASS rejects-empty-implementation', 'PASS scaffold-does-not-pass', 'PASS names-do-not-leak-answers',
    ]);
    expect(ex.status).toBe('approved');
    expect(ex.setup).toBe(SETUP);
  });

  it('verifies in throwaway namespaces and deletes every one of them', async () => {
    resetClusterMemo();
    const cluster = fakeCluster();
    await generateExercise(vault(), 'cka-unready-pods', '', { generate: async () => authored(), cluster: cluster.deps }, 'cluster');
    expect(cluster.namespaces.length).toBeGreaterThanOrEqual(2);
    for (const ns of cluster.namespaces) {
      expect(ns).toMatch(/^mx-verify-/);
      expect(cluster.calls.some((c) => c.args.includes('delete') && c.args.includes(ns))).toBe(true);
    }
  });

  it('rejects a setup that is already healthy — there would be nothing to fix', async () => {
    resetClusterMemo();
    const cluster = fakeCluster();
    const ex = await generateExercise(vault(), 'cka-presolved', '', { generate: async () => authored({ setup: FIX }), cluster: cluster.deps }, 'cluster');
    expect(ex.status).toBe('rejected');
    expect(ex.verification.gates.find((g) => g.gate === 'rejects-empty-implementation')?.ok).toBe(false);
  });

  it('rejects, without touching the cluster, a setup that reaches outside its namespace', async () => {
    resetClusterMemo();
    const cluster = fakeCluster();
    const escape = `${SETUP}---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: oops\n`;
    const ex = await generateExercise(vault(), 'cka-escape', '', { generate: async () => authored({ setup: escape }), cluster: cluster.deps }, 'cluster');
    expect(ex.status).toBe('rejected');
    expect(ex.verification.gates.at(-1)).toMatchObject({ gate: 'stays-in-namespace', ok: false });
    expect(cluster.calls).toEqual([]);
  });

  it('scaffolds the task as comments, so an untouched editor applies nothing', () => {
    const { scaffold } = generatedRungParts({ statement: 'Fix the web Deployment.', entryPoint: 'main', family: 'cluster' });
    expect(scaffold.split('\n').filter((l) => l.trim()).every((l) => l.startsWith('#'))).toBe(true);
    expect(scaffold).toContain('# Fix the web Deployment.');
  });
});

// ── the routes a learner's session goes through ───────────────────────────────────────────────
import { buildBuiltinGapRoutes } from '../src/server/gap/service.js';

/** A fake API server's memory of namespaces: which exist, and the setup hash each was built from. */
function namespaceAware(inner: Exec): Exec {
  const built = new Map<string, string>();
  return async (cmd, args, opts) => {
    const named = args[args.indexOf('namespace') + 1];
    if (args.includes('get') && args.includes('namespace')) {
      return built.has(named)
        ? { code: 0, stderr: '', stdout: JSON.stringify({ metadata: { annotations: { 'myelin.dev/setup-sha': built.get(named) } } }) }
        : { code: 1, stdout: '', stderr: 'NotFound' };
    }
    if (args.includes('apply') && opts?.stdin?.includes('kind: Namespace')) {
      built.set(/name: (\S+)/.exec(opts.stdin)![1], /setup-sha: "(\w+)"/.exec(opts.stdin)![1]);
    }
    if (args.includes('delete') && args.includes('namespace')) built.delete(named);
    return inner(cmd, args, opts);
  };
}

describe('cluster exercise routes', () => {
  async function served() {
    resetClusterMemo();
    const vault = mkdtempSync(join(tmpdir(), 'mx-cluster-routes-'));
    const cluster = fakeCluster();
    await generateExercise(vault, 'cka-unready-pods', '', { generate: async () => authored(), cluster: cluster.deps }, 'cluster');
    cluster.calls.length = 0; // only the learner's traffic from here on
    const inner = cluster.deps.exec;
    const exec = namespaceAware(inner);
    const app = buildBuiltinGapRoutes({ vault, cluster: { ...cluster.deps, exec } });
    const post = (path: string, body: object) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { app, post, calls: cluster.calls, vault };
  }
  const RUNG = 'cka-unready-pods:full_body';

  it('tells the client where the sandbox is, and never ships the setup or the fix', async () => {
    const { app, vault } = await served();
    const payload = await (await app.request('/api/gap/ladder?pattern=cka-unready-pods')).json() as any;
    expect(payload.family).toBe('cluster');
    expect(payload.sandbox.namespace).toBe('mx-cka-unready-pods');
    expect(payload.sandbox.command).toContain(join(vault, '.harness', 'kube'));
    expect(payload.sandbox.command).toContain('--namespace=mx-cka-unready-pods');
    expect(JSON.stringify(payload)).not.toContain('does-not-exist'); // the root cause stays server-side
    expect(JSON.stringify(payload)).not.toContain('nginx:1.27-alpine');
  });

  it('first check builds the session and fails on the broken state; the namespace is then REUSED', async () => {
    const { post, calls } = await served();
    const first = await (await post('/api/gap/run', { rungId: RUNG, code: '# untouched\n' })).json() as any;
    expect(first.pass).toBe(false);
    expect(first.results.find((r: any) => r.name === 'both replicas ready').pass).toBe(false);
    await post('/api/gap/run', { rungId: RUNG, code: '# untouched\n' });
    const opened = calls.filter((c) => c.args.includes('apply') && c.stdin?.includes('kind: Namespace'));
    expect(opened).toHaveLength(1);
  });

  it('YAML in the editor is applied into the session, and a real fix then passes', async () => {
    const { post } = await served();
    const out = await (await post('/api/gap/run', { rungId: RUNG, code: FIX })).json() as any;
    expect(out.pass).toBe(true);
  });

  it('reports a kubectl rejection in the run result instead of a 500', async () => {
    const { post } = await served();
    const out = await (await post('/api/gap/run', { rungId: RUNG, code: 'kind: [unclosed' })).json() as any;
    expect(out.pass).toBe(false);
    expect(out.syntaxError).toMatch(/did not parse/);
  });

  it('reset rebuilds the namespace from the setup without recreating the cluster', async () => {
    const { post, calls } = await served();
    await post('/api/gap/run', { rungId: RUNG, code: FIX });
    calls.length = 0;
    const res = await post('/api/gap/cluster/reset', { pattern: 'cka-unready-pods' });
    expect(await res.json()).toEqual({ ok: true, namespace: 'mx-cka-unready-pods' });
    expect(calls.some((c) => c.args.includes('delete') && c.args.includes('mx-cka-unready-pods'))).toBe(true);
    expect(calls.some((c) => c.stdin?.includes('does-not-exist'))).toBe(true); // the broken setup is back
    expect(calls.some((c) => c.args[0] === 'create')).toBe(false);
  });

  it('reset refuses a pattern that is not a cluster exercise', async () => {
    const { post } = await served();
    expect((await post('/api/gap/cluster/reset', { pattern: 'stream-consumer' })).status).toBe(404);
  });
});

// Found on the first live drive: a learner asked for "a live kubernetes troubleshooting exercise",
// a fitting cluster exercise existed, and code_exercise was withheld as unrelated — because the
// exercise's title describes the situation and shares no word with the request.
import { patternChoices } from '../src/server/gap/service.js';
import { relatedPattern } from '../src/server/session.js';

describe('a cluster exercise is findable by how a learner asks for it', () => {
  it('lists the family\'s subject beside the title, and the topic filter then matches', async () => {
    resetClusterMemo();
    const vault = mkdtempSync(join(tmpdir(), 'mx-cluster-choices-'));
    await generateExercise(vault, 'cka-unready-pods', '', { generate: async () => authored(), cluster: fakeCluster().deps }, 'cluster');
    const choices = patternChoices(vault);
    expect(choices.find((c) => c.startsWith('cka-unready-pods'))).toMatch(/kubernetes cluster sandbox/);
    expect(relatedPattern(choices, ['kubernetes', 'troubleshooting'])).toBe(true);
    expect(relatedPattern(choices, ['photosynthesis'])).toBe(false);
  });
});

describe('the check on open does not wait for a rollout nobody started', () => {
  it('a session this call just built is looked at once; a later check gets the rollout window', async () => {
    resetClusterMemo();
    const vault = mkdtempSync(join(tmpdir(), 'mx-cluster-open-'));
    const cluster = fakeCluster();
    await generateExercise(vault, 'cka-unready-pods', '', { generate: async () => authored(), cluster: cluster.deps }, 'cluster');
    let slept = 0;
    const exec = namespaceAware(cluster.deps.exec);
    let clock = 0;
    const app = buildBuiltinGapRoutes({ vault, cluster: { exec, kubeconfig: KUBECONFIG, now: () => clock, sleep: async (ms) => { slept += ms; clock += ms; } } });
    const run = () => app.request('/api/gap/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rungId: 'cka-unready-pods:full_body', code: '# untouched\n' }) });
    await run();
    expect(slept).toBe(0);
    await run(); // the learner may have just run kubectl — now waiting is right
    expect(slept).toBeGreaterThan(10_000);
  });
});

// ── found in adversarial review of this family ────────────────────────────────────────────────
import { isSafeTarget, setupHash } from '../src/server/gap/cluster.js';

describe('an assertion target cannot become a kubectl flag or reach cluster scope', () => {
  it.each(['deployment/web', 'pod/api-0', 'configmap/app.settings', 'deployments.apps/web'])('%s is allowed', (t) => {
    expect(isSafeTarget(t)).toBe(true);
  });
  // execFile rules out a shell, not a flag: in kubectl's resource position these fetch a URL, read
  // a local file, or read cluster-scoped objects.
  it.each(['--filename=http://127.0.0.1:4820/x', '-f/etc/passwd', '--raw=/api/v1/secrets', 'nodes', 'pods',
    'namespace/kube-system', 'node/myelin-control-plane', 'clusterrole/cluster-admin', 'Deployment/web', 'deployment/web -A', ''])(
    '%j is refused', (t) => { expect(isSafeTarget(t)).toBe(false); });

  it('checkCluster refuses without running kubectl', async () => {
    const { exec, calls } = fakeExec(() => undefined);
    const out = await checkCluster({ exec, kubeconfig: KUBECONFIG },
      'mx-demo', [{ name: 'x', target: '--filename=http://127.0.0.1/x', path: 'a', op: 'exists' }], 0);
    expect(out.pass).toBe(false);
    expect(out.syntaxError).toMatch(/not a namespaced kind\/name/);
    expect(calls).toEqual([]);
  });

  it('the gates reject an exercise carrying one, before touching the cluster', async () => {
    resetClusterMemo();
    const cluster = fakeCluster();
    const cases = [
      { name: 'a', target: '--raw=/api/v1/secrets', path: 'items', op: 'exists' },
      { name: 'b', target: 'deployment/web', path: 'spec.replicas', op: 'eq', value: 2 },
      { name: 'c', target: 'deployment/web', path: 'status.readyReplicas', op: 'eq', value: 2 },
    ];
    const ex = await generateExercise(mkdtempSync(join(tmpdir(), 'mx-target-')), 'cka-flag', '',
      { generate: async () => authored({ cases }), cluster: cluster.deps }, 'cluster');
    expect(ex.status).toBe('rejected');
    expect(cluster.calls).toEqual([]);
  });
});

describe('sandbox namespaces are fenced in', () => {
  it('cuts egress to the namespace and DNS, sets default limits and a pod cap', async () => {
    const { exec, calls } = fakeExec(() => undefined);
    await openNamespace({ exec, kubeconfig: KUBECONFIG }, 'mx-demo', 'kind: ConfigMap\nmetadata:\n  name: a\n');
    const rails = calls.find((c) => c.stdin?.includes('kind: NetworkPolicy'))!;
    expect(rails.args).toEqual(['--kubeconfig', KUBECONFIG, 'apply', '-n', 'mx-demo', '-f', '-']);
    expect(rails.stdin).toContain('policyTypes: [Egress]');
    expect(rails.stdin).toContain('kind: LimitRange');
    expect(rails.stdin).toMatch(/pods: "20"/);
    // and they go in BEFORE the model-written setup starts any pod
    expect(calls.indexOf(rails)).toBeLessThan(calls.findIndex((c) => c.stdin?.includes('kind: ConfigMap')));
  });

  // Policies are additive: an "allow all egress" in a model-written setup would undo the fence.
  it('refuses a NetworkPolicy in model-written YAML', () => {
    expect(validateNamespaced('apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: open\n')).toMatch(/NetworkPolicy/);
  });
});

describe('a regenerated exercise does not inherit the old sandbox', () => {
  it('rebuilds a session namespace that was built from a different setup', async () => {
    resetClusterMemo();
    const vault = mkdtempSync(join(tmpdir(), 'mx-cluster-regen-'));
    const cluster = fakeCluster();
    await generateExercise(vault, 'cka-unready-pods', '', { generate: async () => authored(), cluster: cluster.deps }, 'cluster');
    const exec = namespaceAware(cluster.deps.exec);
    // a namespace left over from an EARLIER version of this pattern
    await openNamespace({ ...cluster.deps, exec }, 'mx-cka-unready-pods', 'kind: ConfigMap\nmetadata:\n  name: old\n');
    cluster.calls.length = 0;
    const app = buildBuiltinGapRoutes({ vault, cluster: { ...cluster.deps, exec } });
    await app.request('/api/gap/run', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'cka-unready-pods:full_body', code: '# untouched\n' }) });
    expect(cluster.calls.some((c) => c.args.includes('delete') && c.args.includes('mx-cka-unready-pods'))).toBe(true);
    const rebuilt = cluster.calls.find((c) => c.stdin?.includes('kind: Namespace'))!;
    expect(rebuilt.stdin).toContain(setupHash(SETUP));
  });
});

describe('a stale "cluster is up" does not outlive a failure', () => {
  it('a failed run forgets the memo, so the next run re-exports the kubeconfig', async () => {
    resetClusterMemo();
    const vault = mkdtempSync(join(tmpdir(), 'mx-cluster-stale-'));
    const cluster = fakeCluster();
    await generateExercise(vault, 'cka-unready-pods', '', { generate: async () => authored(), cluster: cluster.deps }, 'cluster');
    let dockerRestarted = true;
    const exec: Exec = async (cmd, args, opts) => {
      if (cmd === 'kubectl' && dockerRestarted) return { code: 1, stdout: '', stderr: 'connection refused' };
      return namespaceAwareExec(cmd, args, opts);
    };
    const namespaceAwareExec = namespaceAware(cluster.deps.exec);
    const app = buildBuiltinGapRoutes({ vault, cluster: { ...cluster.deps, exec } });
    const run = () => app.request('/api/gap/run', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'cka-unready-pods:full_body', code: '# untouched\n' }) });
    expect((await (await run()).json() as any).syntaxError).toMatch(/connection refused/);
    dockerRestarted = false;
    cluster.calls.length = 0;
    await run();
    expect(cluster.calls.some((c) => c.cmd === 'kind' && c.args[0] === 'export')).toBe(true);
  });
});
