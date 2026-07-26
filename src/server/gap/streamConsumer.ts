// The stream-consumer exercise: the built-in sandbox's first (and so far only) ladder.
//
// This content began life as a scratch-directory "stand-in" for the external the-gap sidecar,
// written so the code_exercise flow could be driven end to end in an environment where that repo
// does not exist. It graduated to a production module because the stand-in was already the real
// thing in every way that matters — it implements the Pinned Contract faithfully, strips answers
// server-side, and its test gauntlet genuinely fails naive implementations — and because a tutor
// that ships with no way to run code at all was the alternative.
//
// Two invariants carried over intact:
//
//  1. `reference_answer` is stripped for every non-worked_example rung BEFORE the payload is
//     serialized (service.ts). There is no second, unstripped endpoint.
//  2. The gauntlet is built so a naive implementation genuinely fails: cases 2, 3 and 5 all catch
//     a parser that assumes one chunk equals one line, which is the entire point of the pattern.

import type { GapRung } from '../gapProxy.js';

const REFERENCE = `async function* parseSSE(chunks) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of chunks) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      yield data;
    }
  }
  const tail = buf.trim();
  if (tail.startsWith('data:')) {
    const data = tail.slice(5).trim();
    if (data !== '[DONE]') yield data;
  }
}`;

const PRE = `// Decode an SSE token stream into event payloads.
// \`chunks\` is an async iterable of Uint8Array. Yield each event's data string.
// Stop at the [DONE] sentinel. Chunk boundaries do NOT align with line boundaries.`;
const POST = `
// Consumers:
//   for await (const token of parseSSE(res.body)) process.stdout.write(token);`;

const SIBLING = `// WORKED EXAMPLE (read-only) — a sibling pattern: length-prefixed framing.
// Same shape of problem: a frame can straddle two reads, so the buffer must persist.
async function* parseFrames(chunks) {
  let buf = new Uint8Array(0);
  for await (const chunk of chunks) {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf); next.set(chunk, buf.length);
    buf = next;
    while (buf.length >= 4) {
      const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
      if (buf.length < 4 + len) break;          // frame not fully arrived yet
      yield new TextDecoder().decode(buf.subarray(4, 4 + len));
      buf = buf.subarray(4 + len);
    }
  }
}`;

/** scaffold = visible_pre + an indented YOUR TURN marker + visible_post, per the contract in
 *  src/client/components/blocks/gap/types.ts. Nothing else — the pre/post fragments already carry
 *  whatever structure the rung needs; the scaffold's only job is to mark the hole between them. */
export const scaffoldFor = (pre: string, post: string) => `${pre}\n  // YOUR TURN — implement this.\n${post}`;

/** A rung as the exercise defines it — GapRung plus the prose/scaffold fields the client reads. */
export interface BuiltinRung extends GapRung {
  /** The function the RUNG's reference defines. Per-rung because the worked example is a SIBLING
   *  artifact with a different entry point (parseFrames, not parseSSE) — the exact mismatch that
   *  blocked predict-the-output when the runner assumed one entry per ladder: running the sibling
   *  against the target's entry produced `ReferenceError: parseSSE is not defined`. */
  entryPoint: string;
  /** Which suite cases a learner can be asked to PREDICT before writing — derived from the suite
   *  (no hand-authored content), restricted to cases whose bytes read cleanly as text so the
   *  question is showable. */
  predictCases: string[];
  prose: {
    context_line?: string;
    hint?: string;
    success_line?: string;
    moves?: { code: string; explanation: string; check?: { question: string; options: [string, string, string]; answerIndex: 0 | 1 | 2 } }[];
  };
  scaffold: string;
}

/** The COMPLETE runnable reference for a rung. full_body's reference stands alone; an
 *  inline_completion's reference is only the hole's contents, so the visible pre/post frame it. */
export function runnableReference(r: Pick<BuiltinRung, 'template' | 'visible_pre' | 'visible_post' | 'reference_answer'>): string {
  return r.template === 'inline_completion'
    ? `${r.visible_pre}\n${r.reference_answer}\n${r.visible_post}`
    : r.reference_answer;
}

const bare: Omit<BuiltinRung, 'scaffold'>[] = [
  {
    id: 'stream-consumer:worked_example',
    template: 'worked_example',
    artifactId: 'frame-consumer',
    entryPoint: 'parseFrames',
    predictCases: [],
    visible_pre: SIBLING,
    visible_post: '',
    reference_answer: SIBLING,
    prose: {
      context_line: 'Read this sibling first — same hazard, different framing.',
      hint: 'Notice what persists across iterations of the outer loop.',
      success_line: 'That buffer-across-reads move is the whole pattern.',
      // REQUIRED by WorkedExample.tsx — it renders "no moves available" (with no way to advance)
      // when absent. Each `code` is a fragment; the component concatenates prior moves' fragments
      // as the accumulating listing, so these must join into a coherent function.
      moves: [
        {
          code: 'async function* parseFrames(chunks) {\n  let buf = new Uint8Array(0);\n',
          explanation: 'The buffer is declared OUTSIDE the loop. That single decision is the pattern — it has to survive across reads.',
        },
        {
          code: '  for await (const chunk of chunks) {\n    const next = new Uint8Array(buf.length + chunk.length);\n    next.set(buf); next.set(chunk, buf.length);\n    buf = next;\n',
          explanation: 'Each read appends to what we already had, rather than replacing it.',
        },
        {
          code: '    while (buf.length >= 4) {\n      const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);\n',
          explanation: 'A 4-byte prefix tells us how long the frame is. We can only read it once at least 4 bytes have arrived.',
          check: {
            question: 'The prefix says the frame is 900 bytes, but the buffer holds 120. What now?',
            options: [
              'Yield what we have and move on',
              'Stop and wait for the next read',
              'Throw — the stream is malformed',
            ],
            answerIndex: 1,
          },
        },
        {
          code: '      if (buf.length < 4 + len) break;\n',
          explanation: 'Break out and wait. The frame is not corrupt, it is simply incomplete — the next read will finish it.',
        },
        {
          code: '      yield new TextDecoder().decode(buf.subarray(4, 4 + len));\n      buf = buf.subarray(4 + len);\n    }\n  }\n}',
          explanation: 'Emit the complete frame and advance past it, leaving any partial remainder in the buffer for next time.',
        },
      ],
    },
  },
  {
    id: 'stream-consumer:inline_completion',
    template: 'inline_completion',
    artifactId: 'stream-consumer',
    entryPoint: 'parseSSE',
    predictCases: ['one event per chunk', 'stops at the [DONE] sentinel'],
    visible_pre: `${PRE}\nasync function* parseSSE(chunks) {\n  const decoder = new TextDecoder();\n  let buf = '';\n  for await (const chunk of chunks) {`,
    visible_post: `  }\n}\n${POST}`,
    reference_answer: `    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      yield data;
    }`,
    prose: {
      context_line: 'The buffer and decoder are set up. Fill in the loop body.',
      hint: 'decode() takes a { stream: true } option for a reason.',
      success_line: 'Stateful decode plus stateful split — both had to persist.',
    },
  },
  {
    id: 'stream-consumer:full_body',
    template: 'full_body',
    artifactId: 'stream-consumer',
    entryPoint: 'parseSSE',
    predictCases: ['stops at the [DONE] sentinel'],
    visible_pre: PRE,
    visible_post: POST,
    reference_answer: REFERENCE,
    prose: {
      context_line: 'Whole function now, graded against the real suite.',
      hint: 'Five cases: clean chunks, a split event, a split UTF-8 character, [DONE], and a trailing line with no newline.',
      success_line: 'That is the pattern earned rather than watched.',
    },
  },
];

export const STREAM_CONSUMER_RUNGS: BuiltinRung[] =
  bare.map((r) => ({ ...r, scaffold: scaffoldFor(r.visible_pre, r.visible_post) }));

export const STREAM_CONSUMER_LADDER = {
  pattern: 'stream-consumer',
  targetArtifactId: 'stream-consumer',
  siblingArtifactId: 'frame-consumer',
  rungs: STREAM_CONSUMER_RUNGS.map((r) => r.id),
};

/** A test case in wire-safe form: chunk bytes as plain number arrays, because they cross a process
 *  boundary as JSON on their way to the runner child (runner.ts). */
export interface SuiteCase { name: string; chunks: number[][]; expect: string[] }

const bytes = (s: string): number[] => [...new TextEncoder().encode(s)];

/** Deliberately awkward chunk boundaries — this is the gauntlet, not decoration. */
export const STREAM_CONSUMER_CASES: SuiteCase[] = [
  {
    name: 'one event per chunk',
    chunks: [bytes('data: Hello\n'), bytes('data: world\n')],
    expect: ['Hello', 'world'],
  },
  {
    name: 'single event split across two chunks',
    chunks: [bytes('data: Hel'), bytes('lo\ndata: there\n')],
    expect: ['Hello', 'there'],
  },
  {
    name: 'multi-byte UTF-8 character split across chunks',
    // 'é' is 0xC3 0xA9 — split between the two chunks on purpose.
    chunks: [[...bytes('data: caf'), 0xc3], [0xa9, ...bytes('\n')]],
    expect: ['café'],
  },
  {
    name: 'stops at the [DONE] sentinel',
    chunks: [bytes('data: a\ndata: [DONE]\ndata: never\n')],
    expect: ['a'],
  },
  {
    name: 'flushes a trailing line with no newline',
    chunks: [bytes('data: last')],
    expect: ['last'],
  },
];

/**
 * Adversarial re-chunkings of a case's SAME bytes and SAME expectation. Derived mechanically from
 * the existing cases rather than hand-authored, which is the point: it costs no new content per
 * artifact, and passing the normal suite while failing this is exactly the signal an expert wants.
 */
export function stressCases(cases: SuiteCase[] = STREAM_CONSUMER_CASES): SuiteCase[] {
  const modes: { name: string; split: (b: number[]) => number[][] }[] = [
    { name: 'one byte per read', split: (b) => b.map((x) => [x]) },
    { name: 'entire body in one read', split: (b) => [b] },
    { name: 'empty reads interleaved', split: (b) => b.flatMap((x) => [[], [x]]) },
  ];
  return cases.flatMap((c) => {
    const flat = c.chunks.flat();
    return modes.map((m) => ({ name: `${c.name} — ${m.name}`, chunks: m.split(flat), expect: c.expect }));
  });
}

/** The entry-point name the suite calls — the child harness appends `;<entryPoint>` to the
 *  learner's code to pluck the function out of the evaluated scope. */
export const STREAM_CONSUMER_ENTRY = 'parseSSE';
