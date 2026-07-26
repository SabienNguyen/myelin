// Generated exercises — backlog item 2, on the plan's seam: a model may AUTHOR, only the real
// suite may GRADE, and nothing generated reaches a learner without passing mechanical gates AND a
// human approval. The whole risk is "a vacuous generated suite mints false mastery", so the gate
// tests here are the ones that matter; the happy path is almost incidental.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateExercise, listGenerated, approvedGenerated, setGeneratedStatus, verifyExercise,
} from '../src/server/gap/generated.js';
import { buildBuiltinGapRoutes, builtinPatterns } from '../src/server/gap/service.js';

/** A REAL second exercise: newline-delimited JSON values. Same family as stream-consumer, written
 *  to survive the harness's hostile 7-byte chunking. */
const NDJSON = {
  title: 'Parsing NDJSON streams',
  entryPoint: 'parseNDJSON',
  statement: 'Decode a stream of newline-delimited JSON scalars.\nYield each parsed value as a string.\nA line may arrive split across reads. Skip blank lines.',
  reference: `async function* parseNDJSON(chunks) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of chunks) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield String(JSON.parse(line));
    }
  }
  const tail = buf.trim();
  if (tail) yield String(JSON.parse(tail));
}`,
  cases: [
    { name: 'one value per line', inputText: '"alpha"\n"beta"\n', expect: ['alpha', 'beta'] },
    { name: 'a line split across reads', inputText: '"a long value here"\n42\n', expect: ['a long value here', '42'] },
    { name: 'skips blank lines', inputText: '"x"\n\n\n"y"\n', expect: ['x', 'y'] },
    { name: 'flushes a trailing line with no newline', inputText: '"last"', expect: ['last'] },
  ],
  prose: { context_line: 'Same buffering hazard, new framing.', hint: 'The tail matters.', success_line: 'Earned.' },
};

const stubModel = (payload: unknown) => async () => JSON.stringify(payload);

let vault: string;
beforeEach(() => { vault = mkdtempSync(join(tmpdir(), 'lwh-gen-')); });

describe('the verification gates', () => {
  it('admits a real exercise', async () => {
    const report = await verifyExercise(NDJSON);
    expect(report.gates.map((g) => `${g.ok ? '+' : '-'}${g.gate}`)).toEqual([
      '+suite-size', '+reference-passes', '+rejects-empty-implementation',
      '+scaffold-does-not-pass', '+names-do-not-leak-answers',
    ]);
    expect(report.ok).toBe(true);
  });

  it('REJECTS a vacuous suite — the one that would mint false mastery', async () => {
    // Every case expects nothing, so an implementation that does nothing "passes". Gate 2 exists
    // for exactly this, and the plan marks it must-never-skip.
    const vacuous = {
      ...NDJSON,
      cases: [
        { name: 'a', inputText: 'x', expect: [] }, { name: 'b', inputText: 'y', expect: [] },
        { name: 'c', inputText: 'z', expect: [] },
      ],
      reference: `async function* parseNDJSON(chunks) { for await (const c of chunks) {} }`,
    };
    const report = await verifyExercise(vacuous);
    expect(report.ok).toBe(false);
    expect(report.gates.find((g) => g.gate === 'rejects-empty-implementation')?.ok).toBe(false);
  });

  it('rejects a reference that fails its own suite', async () => {
    // Forgetting to parse: yields the raw line ('"alpha"', quotes included) instead of the value.
    const broken = { ...NDJSON, reference: NDJSON.reference.replaceAll('String(JSON.parse(line))', 'line').replaceAll('String(JSON.parse(tail))', 'tail') };
    const report = await verifyExercise(broken);
    expect(report.ok).toBe(false);
    expect(report.gates.find((g) => g.gate === 'reference-passes')?.ok).toBe(false);
  });

  it('rejects a case whose NAME contains its answer', async () => {
    const leaky = {
      ...NDJSON,
      cases: NDJSON.cases.map((c, i) => (i === 0 ? { ...c, name: 'yields alpha then beta' } : c)),
    };
    const report = await verifyExercise(leaky);
    expect(report.ok).toBe(false);
    expect(report.gates.find((g) => g.gate === 'names-do-not-leak-answers')?.detail).toContain('alpha');
  });

  it('rejects a suite too small to be a gauntlet', async () => {
    const tiny = { ...NDJSON, cases: NDJSON.cases.slice(0, 2) };
    expect((await verifyExercise(tiny)).ok).toBe(false);
  });
});

describe('generate -> review -> serve', () => {
  it('a generated exercise lands PENDING, and pending is NOT served', async () => {
    const ex = await generateExercise(vault, 'ndjson-parser', 'parse ndjson', { generate: stubModel(NDJSON) });
    expect(ex.status).toBe('pending');
    expect(ex.verification.ok).toBe(true);
    expect(builtinPatterns(vault)).not.toContain('ndjson-parser');
    expect(approvedGenerated(vault)).toHaveLength(0);
  });

  it('a generation that fails the gates is auto-rejected with the gate named', async () => {
    const bad = { ...NDJSON, cases: NDJSON.cases.slice(0, 2) };
    const ex = await generateExercise(vault, 'bad-one', '', { generate: stubModel(bad) });
    expect(ex.status).toBe('rejected');
    expect(ex.verification.gates.find((g) => !g.ok)?.gate).toBe('suite-size');
  });

  it('approval makes it a first-class exercise: ladder, run, predict — the exact machinery the hand-built one uses', async () => {
    await generateExercise(vault, 'ndjson-parser', '', { generate: stubModel(NDJSON) });
    setGeneratedStatus(vault, 'ndjson-parser', 'approved');
    expect(builtinPatterns(vault)).toContain('ndjson-parser');

    const app = buildBuiltinGapRoutes({ vault });
    const ladder = await (await app.request('/api/gap/ladder?pattern=ndjson-parser')).json();
    expect(ladder.ladder.pattern).toBe('ndjson-parser');
    expect(ladder.rungs[0].reference_answer).toBe(''); // stripped, like every learner rung
    expect(ladder.rungs[0].predict.length).toBeGreaterThan(0);

    const run = await (await app.request('/api/gap/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'ndjson-parser:full_body', code: NDJSON.reference }),
    })).json();
    expect(run.pass).toBe(true);
    expect(run.results).toHaveLength(4);

    const predict = await (await app.request('/api/gap/predict', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'ndjson-parser:full_body', caseName: 'one value per line', prediction: ['alpha', 'beta'] }),
    })).json();
    expect(predict.pass).toBe(true);
  });

  it('an approval cannot overrule failed gates — verification is not a formality', async () => {
    const bad = { ...NDJSON, cases: NDJSON.cases.slice(0, 2) };
    await generateExercise(vault, 'bad-one', '', { generate: stubModel(bad) });
    setGeneratedStatus(vault, 'bad-one', 'approved');
    expect(approvedGenerated(vault)).toHaveLength(0); // approved AND verified is the bar
    expect(builtinPatterns(vault)).not.toContain('bad-one');
  });

  it('the review surface lists everything with its gates visible', async () => {
    await generateExercise(vault, 'ndjson-parser', '', { generate: stubModel(NDJSON) });
    const app = buildBuiltinGapRoutes({ vault });
    const body = await (await app.request('/api/gap/generated')).json();
    expect(body.exercises).toHaveLength(1);
    expect(body.exercises[0].status).toBe('pending');
    expect(body.exercises[0].verification.gates.length).toBe(5);
  });

  it('the pattern list includes approved generated exercises — Practice reads this', async () => {
    await generateExercise(vault, 'ndjson-parser', '', { generate: stubModel(NDJSON) });
    const app = buildBuiltinGapRoutes({ vault });
    // Pending: not listed.
    let body = await (await app.request('/api/gap/patterns')).json();
    expect(body.patterns.map((p: any) => p.pattern)).toEqual(['stream-consumer']);
    // Approved: listed after the builtin.
    setGeneratedStatus(vault, 'ndjson-parser', 'approved');
    body = await (await app.request('/api/gap/patterns')).json();
    expect(body.patterns.map((p: any) => p.pattern)).toEqual(['stream-consumer', 'ndjson-parser']);
  });

  it('a model returning garbage is an error, not a stored exercise', async () => {
    await expect(generateExercise(vault, 'x', '', { generate: async () => 'not json at all' }))
      .rejects.toThrow(/valid JSON/);
    expect(listGenerated(vault)).toHaveLength(0);
  });
});
