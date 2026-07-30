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
    // Only the factory demo carries the builtin flag — Practice hides an untouched builtin, and a
    // generated pattern must never inherit that fate (it exists because the learner did something).
    expect(body.patterns.map((p: any) => p.builtin === true)).toEqual([true, false]);
  });

  it('a model returning garbage is an error, not a stored exercise', async () => {
    await expect(generateExercise(vault, 'x', '', { generate: async () => 'not json at all' }))
      .rejects.toThrow(/valid JSON/);
    expect(listGenerated(vault)).toHaveLength(0);
  });
});

// ── the function family: any-domain computations, same defence ─────────────────────────────────
//
// A chemistry exercise, on purpose — the family exists so "practice this as code" works from any
// page, and a non-programming domain is the proof. Molarity dilution: C1V1 = C2V2.

const DILUTION = {
  title: 'Dilution calculator',
  entryPoint: 'dilutionVolume',
  statement: 'Given stock concentration C1 (mol/L), target concentration C2, and target volume V2 (mL),\nreturn the stock volume V1 in mL, rounded to 2 decimal places.\nThrow if C2 > C1 — you cannot dilute upward.',
  reference: `function dilutionVolume(c1, c2, v2) {
  if (c2 > c1) throw new Error('cannot dilute upward');
  return Math.round((c2 * v2 / c1) * 100) / 100;
}`,
  cases: [
    { name: 'a simple tenfold dilution', args: [1.0, 0.1, 100], expect: 10 },
    { name: 'rounds to 2 decimal places', args: [3, 0.7, 50], expect: 11.67 },
    { name: 'target equals stock', args: [2, 2, 40], expect: 40 },
    { name: 'fractional target volume', args: [0.5, 0.2, 25.5], expect: 10.2 },
  ],
  prose: { context_line: 'C1V1 = C2V2, earned.', hint: 'Solve for V1.', success_line: 'That is the lab math.' },
};

describe('the function family (any-domain exercises)', () => {
  it('admits a real domain exercise through the same gates', async () => {
    const report = await verifyExercise({ ...DILUTION, family: 'function' });
    expect(report.gates.map((g) => `${g.ok ? '+' : '-'}${g.gate}`)).toEqual([
      '+suite-size', '+reference-passes', '+rejects-empty-implementation',
      '+scaffold-does-not-pass', '+names-do-not-leak-answers',
    ]);
    expect(report.ok).toBe(true);
  });

  it('REJECTS a vacuous function suite — undefined must not equal anything', async () => {
    const vacuous = {
      ...DILUTION,
      family: 'function' as const,
      reference: `function dilutionVolume() {}`,
      cases: DILUTION.cases.slice(0, 3),
    };
    const report = await verifyExercise(vacuous);
    expect(report.ok).toBe(false);
    // The empty reference fails its own suite AND the vacuous gate would pass it — both gates
    // report; reference-passes is the first to object.
    expect(report.gates.find((g) => g.gate === 'reference-passes')?.ok).toBe(false);
  });

  it('rejects a function case whose NAME contains its answer', async () => {
    const leaky = {
      ...DILUTION,
      family: 'function' as const,
      cases: DILUTION.cases.map((c, i) => (i === 0 ? { ...c, name: 'returns 10 for tenfold' } : c)),
    };
    const report = await verifyExercise(leaky);
    expect(report.ok).toBe(false);
  });

  // A STRING answer is the case the numeric test above misses: JSON.stringify wraps it in quotes,
  // so a name that contains the bare word used to slip through the leak gate. Text processing is a
  // named target of this family, so the gate must catch it.
  const INITIALS = {
    title: 'Initials',
    entryPoint: 'initials',
    statement: 'Return the uppercase initials of a full name (first letter of each space-separated word).',
    reference: `function initials(name) { return name.split(' ').map((w) => w[0].toUpperCase()).join(''); }`,
    cases: [
      { name: 'a two part name', args: ['john doe'], expect: 'JD' },
      { name: 'a three part name', args: ['mary jane watson'], expect: 'MJW' },
      { name: 'a single name', args: ['cher'], expect: 'C' },
    ],
    prose: { context_line: 'Initials, earned.', hint: 'First letter of each word.', success_line: 'That is string work.' },
  };

  it('admits a clean string-returning exercise', async () => {
    expect((await verifyExercise({ ...INITIALS, family: 'function' })).ok).toBe(true);
  });

  it('rejects a string-returning case whose NAME contains its (unquoted) answer', async () => {
    const leaky = {
      ...INITIALS,
      family: 'function' as const,
      cases: INITIALS.cases.map((c, i) => (i === 0 ? { ...c, name: 'yields JD for a two part name' } : c)),
    };
    const report = await verifyExercise(leaky);
    expect(report.ok).toBe(false);
    expect(report.gates.find((g) => g.gate === 'names-do-not-leak-answers')?.detail).toContain('JD');
  });

  it('generate -> approve -> ladder/run/predict, function family end to end', async () => {
    await generateExercise(vault, 'dilution-calculator', 'chemistry: dilutions', { generate: stubModel(DILUTION) }, 'function');
    setGeneratedStatus(vault, 'dilution-calculator', 'approved');
    expect(builtinPatterns(vault)).toContain('dilution-calculator');

    const app = buildBuiltinGapRoutes({ vault });
    const ladder = await (await app.request('/api/gap/ladder?pattern=dilution-calculator')).json();
    expect(ladder.rungs[0].reference_answer).toBe(''); // stripped for the function family too
    // The predict question shows the CALL, not the answer.
    expect(ladder.rungs[0].predict[0].inputPreview).toBe('dilutionVolume(1, 0.1, 100)');

    const run = await (await app.request('/api/gap/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'dilution-calculator:full_body', code: DILUTION.reference }),
    })).json();
    expect(run.pass).toBe(true);
    expect(run.results).toHaveLength(4);

    // A wrong implementation fails with expected/actual revealed only on the failing case.
    const wrong = await (await app.request('/api/gap/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'dilution-calculator:full_body', code: 'function dilutionVolume(c1, c2, v2) { return c2 * v2 / c1; }' }),
    })).json();
    expect(wrong.pass).toBe(false);
    expect(wrong.results.find((r: any) => !r.pass).expected).toBeDefined();

    // Predict accepts the value however the learner types it: bare or JSON.
    const predict = await (await app.request('/api/gap/predict', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'dilution-calculator:full_body', caseName: 'a simple tenfold dilution', prediction: ['10'] }),
    })).json();
    expect(predict.pass).toBe(true);

    // Scratch run: learner-typed args as a JSON array, result back, nothing leaked.
    const scratch = await (await app.request('/api/gap/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'dilution-calculator:full_body', code: DILUTION.reference, input: '[2, 1, 30]' }),
    })).json();
    expect(scratch.scratch).toBe(true);
    expect(scratch.actual).toBe('15');

    // Stress is a stream idea; a function run must not pretend it stressed anything.
    const stress = await (await app.request('/api/gap/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'dilution-calculator:full_body', code: DILUTION.reference, stress: true }),
    })).json();
    expect(stress.pass).toBe(true);
    expect(stress.stressed).toBeUndefined();
  });

  it('a throwing case reports "threw:" as the actual', async () => {
    await generateExercise(vault, 'dilution-calculator', '', { generate: stubModel(DILUTION) }, 'function');
    setGeneratedStatus(vault, 'dilution-calculator', 'approved');
    const app = buildBuiltinGapRoutes({ vault });
    const run = await (await app.request('/api/gap/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rungId: 'dilution-calculator:full_body',
        code: 'function dilutionVolume() { throw new Error("boom"); }',
      }),
    })).json();
    expect(run.pass).toBe(false);
    // Cross-realm quirk: an Error minted inside the vm context fails the child's `instanceof
    // Error` check, so the whole String(e) lands here — 'threw: Error: boom'. Fine for a learner.
    expect(run.results[0].actual).toContain('threw:');
    expect(run.results[0].actual).toContain('boom');
  });

  it('stored stream exercises without a family field still verify as stream', async () => {
    // Files written before the family existed have no `family` key — familyOf defaults them.
    const report = await verifyExercise(NDJSON);
    expect(report.ok).toBe(true);
  });
});
