import { useState } from 'react';

export interface SandboxInfo { namespace: string; kubeconfig: string; command: string }

/** The strip above a cluster exercise's editor: where the live sandbox is and how to reach it.
 *
 * The work happens in the learner's OWN terminal — that is the skill being practised — so the one
 * thing this has to do well is hand over the command that points a shell at the right cluster and
 * namespace. Reset rebuilds the namespace from the exercise's setup; the cluster itself is never
 * rebuilt, which is why it takes seconds. */
export function ClusterSandbox({ pattern, sandbox, onReset }: {
  pattern: string; sandbox: SandboxInfo; onReset: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(sandbox.command);
      setCopied(true);
    } catch (e) {
      setNote(`copy failed: ${e instanceof Error ? e.message : String(e)} — select the command instead`);
    }
  }

  async function reset() {
    setResetting(true);
    setNote('resetting the sandbox to its starting state…');
    try {
      const res = await fetch('/api/gap/cluster/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pattern }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setNote(`reset failed: ${(data as { error?: string }).error ?? 'unknown error'}`); return; }
      setNote(null);
      onReset();
    } catch (e) {
      setNote(`reset failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setResetting(false);
    }
  }

  return (
    <section className="cluster-sandbox" aria-label="Live cluster sandbox">
      <p className="cluster-sandbox-lede">
        live sandbox · namespace <code>{sandbox.namespace}</code> · paste this in your terminal, then use kubectl
      </p>
      <div className="cluster-sandbox-row">
        <code className="cluster-sandbox-command">{sandbox.command}</code>
        <button type="button" onClick={copy}>{copied ? 'copied' : 'copy'}</button>
        <button type="button" onClick={reset} disabled={resetting}>reset sandbox</button>
      </div>
      {note !== null && <p className="cluster-sandbox-note" role="status">{note}</p>}
    </section>
  );
}
