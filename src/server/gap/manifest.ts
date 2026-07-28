// The manifest exercise family: Kubernetes-style practice ("write the Deployment this task
// describes") graded by MECHANICAL assertions over the parsed YAML.
//
// Why this needs no child process: the other two families execute learner CODE, and code gets the
// killable child. A manifest is DATA — grading it is parse-then-inspect, with nothing to run, so
// it happens right here in the server process. js-yaml's default schema never constructs
// functions or arbitrary objects, and yaml.loadAll with no custom types is safe on hostile input.
//
// What this deliberately is not: a cluster. Nothing here runs kubectl, schedules pods, or checks
// that a manifest ACTUALLY WORKS — it checks that the manifest says what the task demanded. That
// covers the write-a-manifest-from-a-spec slice of certification prep (CKA/CKAD tasks are mostly
// exactly this), and the copy in the UI must never imply more.

import { loadAll } from 'js-yaml';
import type { RunnerResult } from './runner.js';
import { canonicalJSON } from './canonical.js';

/** One graded requirement: a dot-path into the parsed document and an expectation about what
 *  lives there. Paths use dots and [n] for arrays ('spec.template.spec.containers[0].image');
 *  a multi-document file is addressed as docs[n].<path>, and a bare path means document 0. */
export interface ManifestAssertion {
  name: string;
  path: string;
  op: 'eq' | 'exists' | 'absent' | 'matches';
  /** eq: deep-compared JSON value. matches: a regex source tested against String(found). */
  value?: unknown;
}

/** Tokenize a path into keys and array indices. Dotted segments (a.b), array indices (a[0]), and —
 *  the addition — BRACKET-QUOTED keys for names that themselves contain dots or slashes:
 *  metadata.labels['app.kubernetes.io/name']. Those keys are everywhere in Kubernetes (the whole
 *  recommended-label set is dotted), and a plain dot-split can't address them — so an assertion on
 *  one used to make the reference fail its OWN gate, quietly barring a big slice of CKA/CKAD tasks. */
export function tokenizePath(path: string): (string | number)[] {
  const parts: (string | number)[] = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === '.') { i++; continue; }
    if (path[i] === '[') {
      const close = path.indexOf(']', i);
      if (close === -1) { parts.push(path.slice(i + 1)); break; } // malformed — best-effort
      const inner = path.slice(i + 1, close);
      if (/^(['"]).*\1$/.test(inner)) parts.push(inner.slice(1, -1)); // ['dotted.key']
      else if (/^\d+$/.test(inner)) parts.push(Number(inner));        // [0] array index
      else parts.push(inner);                                          // [bareword] — lenient
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
    parts.push(path.slice(i, j));
    i = j;
  }
  return parts;
}

/** Resolve a dot/[n]/['key'] path against a parsed document. Returns { found } so a legitimately-null
 *  value is distinguishable from a missing one. */
export function resolvePath(root: unknown, path: string): { found: boolean; value?: unknown } {
  const parts = tokenizePath(path);
  let cur: any = root;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return { found: false };
    if (!(part in cur)) return { found: false };
    cur = cur[part];
  }
  return { found: true, value: cur };
}

const show = (v: unknown) => (v === undefined ? '(undefined)' : JSON.stringify(v));

/**
 * Grade a learner's YAML against the assertions. Returns the same RunnerResult shape the child
 * runner produces, so /api/gap/run's consumers (TestResultsPanel, grading.ts, the reveal ceiling)
 * need no new case. A parse error lands in syntaxError — same slot a JS syntax error uses.
 */
export function gradeManifest(yamlText: string, assertions: ManifestAssertion[]): RunnerResult {
  let docs: unknown[];
  try {
    docs = loadAll(yamlText).filter((d) => d !== null && d !== undefined);
  } catch (e) {
    return { pass: false, results: [], syntaxError: `YAML did not parse: ${e instanceof Error ? e.message : String(e)}` };
  }

  const results: RunnerResult['results'] = [];
  const fired: string[] = [];
  for (const a of assertions) {
    const docMatch = /^docs\[(\d+)\]\.(.*)$/.exec(a.path);
    const root = docMatch ? docs[Number(docMatch[1])] : docs[0];
    const path = docMatch ? docMatch[2] : a.path;
    const { found, value } = resolvePath(root, path);

    let ok = false;
    let expected = '';
    let actual = '';
    switch (a.op) {
      case 'exists':
        ok = found;
        expected = `${a.path} present`;
        actual = found ? 'present' : 'missing';
        break;
      case 'absent':
        ok = !found;
        expected = `${a.path} absent`;
        actual = found ? `present: ${show(value)}` : 'absent';
        break;
      case 'matches':
        ok = found && new RegExp(String(a.value ?? '')).test(String(value));
        expected = `${a.path} matching /${String(a.value ?? '')}/`;
        actual = found ? show(value) : 'missing';
        break;
      case 'eq':
      default:
        // canonicalJSON, not raw stringify: a YAML map is unordered, so a learner whose labels read
        // { tier, app } must match an expected { app, tier }. Arrays keep their order (a container
        // list or args sequence is meaning), which canonicalJSON preserves.
        ok = found && canonicalJSON(value) === canonicalJSON(a.value);
        expected = show(a.value);
        actual = found ? show(value) : 'missing';
        break;
    }
    const row: RunnerResult['results'][number] = { name: a.name, pass: ok };
    if (!ok) { row.expected = expected; row.actual = actual; }
    results.push(row);
    if (ok) fired.push(a.name);
  }
  return { pass: results.every((r) => r.pass), results, trace: { fired } };
}

/** Scratch for manifests: "what does my YAML parse to" — the parsed documents back as JSON,
 *  nothing asserted, nothing revealed. The exact same contract shape as the code families'
 *  scratch runs. */
export function scratchManifest(yamlText: string): RunnerResult {
  try {
    const docs = loadAll(yamlText).filter((d) => d !== null && d !== undefined);
    return { pass: true, results: [], scratch: true, actual: JSON.stringify(docs.length === 1 ? docs[0] : docs) };
  } catch (e) {
    return { pass: false, results: [], scratch: true, runtimeError: `YAML did not parse: ${e instanceof Error ? e.message : String(e)}` };
  }
}
