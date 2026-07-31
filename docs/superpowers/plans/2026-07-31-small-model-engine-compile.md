# Small-Model Engine + Compile Refit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the harness-drives/model-fills-slots pattern into `src/server/pipeline.ts` and refit the weak-model compile path onto it: diagnosed failures, parallel part distillation, and a Map-of-Content hub page per multi-part chapter.

**Architecture:** A pure orchestration module (fit math → classify failures → bounded-parallel map with retry ladder → consumer floor) with zero I/O of its own; compile (`src/server/ingest.ts`) becomes its first consumer. The agentic strong-model compile path is untouched and stays sequential (part N+1's link candidates need part N's pages); only the weak-model distillation path parallelizes.

**Tech Stack:** TypeScript (ESM), zod, vitest; existing seams: `generateStructured`, `chunkChapter`, `streamModel`/`textModel` fakes, `queueStore` ledger.

**Spec:** `docs/superpowers/specs/2026-07-31-small-model-pipeline-design.md` (§1, §2, §4, §7). Vote (`vote: n`) is deliberately deferred to the research plan — its first consumer.

## Global Constraints

- Engram stays the only writer of `pages/`: every page write goes through the citation-wrapped `write_page` execute.
- Failure classes are exactly `'overflow' | 'weak-output' | 'transport'`; transport always re-throws (queues must retry later).
- Ledger notes name the class: `part 3: verbatim (weak-output: …)` — "fallback" with no reason is a plan failure.
- No new dependencies. Run `npm run typecheck` and `npx vitest run <file>` per task; full `npx vitest run` before the final commit of each task.
- House style: comments explain failure modes, not lines (no-slop-code skill).

---

### Task 1: pipeline.ts — budget math + failure classification

**Files:**
- Create: `src/server/pipeline.ts`
- Test: `tests/pipeline.test.ts`
- Modify: `src/server/ingest.ts` (move `isTransportFailure` out, re-import)

**Interfaces:**
- Consumes: `LlmHttpError` from `./llm/index.js`.
- Produces (later tasks + research plan rely on these exact names):
  - `type PipelineFailureClass = 'overflow' | 'weak-output' | 'transport'`
  - `budgetChars(contextTokens: number | undefined): number`
  - `classifyFailure(e: unknown, promptChars: number, budget: number): PipelineFailureClass`
  - `isTransportFailure(e: unknown): boolean` (moved verbatim from ingest.ts)

- [ ] **Step 1: Write the failing test**

```ts
// tests/pipeline.test.ts
import { describe, it, expect } from 'vitest';
import { budgetChars, classifyFailure, isTransportFailure } from '../src/server/pipeline.js';
import { LlmHttpError } from '../src/server/llm/index.js';

describe('budgetChars', () => {
  it('derives a char budget from contextTokens with scaffold headroom', () => {
    // tokens*4 chars minus 8k scaffold reserve (system + schema + instructions)
    expect(budgetChars(32_768)).toBe(32_768 * 4 - 8_000);
  });
  it('falls back to the proven CHAPTER_CHUNK_CHARS default when unset', () => {
    expect(budgetChars(undefined)).toBe(24_000);
  });
  it('never returns less than 4k chars even for a tiny window', () => {
    expect(budgetChars(1_000)).toBe(4_000);
  });
});

describe('classifyFailure', () => {
  it('transport: LlmHttpError and undici fetch-failed', () => {
    expect(classifyFailure(new LlmHttpError(503, 'boom', 'x'), 10, 100)).toBe('transport');
    expect(classifyFailure(new TypeError('fetch failed'), 10, 100)).toBe('transport');
  });
  it('overflow: the prompt did not fit the budget', () => {
    expect(classifyFailure(new Error('schema rejected'), 200, 100)).toBe('overflow');
  });
  it('weak-output: it fit, the model still failed', () => {
    expect(classifyFailure(new Error('schema rejected'), 50, 100)).toBe('weak-output');
  });
});
```

- [ ] **Step 2: Run it — must fail with "Cannot find module '../src/server/pipeline.js'"**

Run: `npx vitest run tests/pipeline.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/server/pipeline.ts
// The small-model engine (spec 2026-07-31): the harness decides, the model fills one narrow
// slot per call. Pure orchestration — no I/O of its own; consumers hand in the model calls.
import { LlmHttpError } from './llm/index.js';

export type PipelineFailureClass = 'overflow' | 'weak-output' | 'transport';

/** Endpoint-unreachable/erroring — not model-too-weak. LlmHttpError covers every non-2xx the
 * adapters surface (post-retry); undici's "fetch failed" TypeError is the connection-level face.
 * (Moved verbatim from ingest.ts — one definition, two consumers.) */
export function isTransportFailure(e: unknown): boolean {
  if (e instanceof LlmHttpError) return true;
  return e instanceof TypeError && /fetch failed/i.test(e.message);
}

/** Chars a single call may spend on PAYLOAD. tokens*4 is the standard floor estimate; 8k chars
 * are reserved for system + schema + instructions so the payload never truncates them out.
 * No contextTokens configured → the 24k default CHAPTER_CHUNK_CHARS proved for two years. */
export function budgetChars(contextTokens: number | undefined): number {
  if (!contextTokens) return 24_000;
  return Math.max(4_000, contextTokens * 4 - 8_000);
}

/** Why a piece failed, decided BEFORE any fallback runs — the remedies differ (split vs retry vs
 * wait-and-requeue) and "it fell back" without a why is a bug per the spec. */
export function classifyFailure(e: unknown, promptChars: number, budget: number): PipelineFailureClass {
  if (isTransportFailure(e)) return 'transport';
  if (promptChars > budget) return 'overflow';
  return 'weak-output';
}
```

In `src/server/ingest.ts`: delete the local `isTransportFailure` (lines ~548-551) and its `LlmHttpError` import if now unused; add `import { isTransportFailure } from './pipeline.js';`.

- [ ] **Step 4: Run tests — pipeline.test.ts green, then `npx vitest run tests/ingest 2>/dev/null || npx vitest run` to prove the move broke nothing**

- [ ] **Step 5: Commit** — `git add src/server/pipeline.ts tests/pipeline.test.ts src/server/ingest.ts && git commit -m "feat: pipeline engine — budget math and diagnosed failure classes"`

---

### Task 2: pipeline.ts — mapPieces (bounded-parallel map + retry ladder + floors + receipts)

**Files:**
- Modify: `src/server/pipeline.ts`
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PieceReceipt { piece: number; outcome: 'ok' | 'floored'; reason?: string; class?: PipelineFailureClass }
  export async function mapPieces<T>(opts: {
    pieces: string[];
    budget: number;
    concurrency?: number;                       // default 4
    attempt: (piece: string, rejection?: string) => Promise<T>;  // one model call; throw = failed
    floor: (piece: string, cls: PipelineFailureClass, reason: string) => Promise<T>;
  }): Promise<{ results: T[]; receipts: PieceReceipt[] }>
  ```
- Ladder per piece: `attempt()` → on failure retry once with the rejection message → on second failure `classifyFailure` → transport re-throws (fails the whole map), otherwise `floor()` with class+reason. `results[i]` always corresponds to `pieces[i]`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/pipeline.test.ts
import { mapPieces } from '../src/server/pipeline.js';

describe('mapPieces', () => {
  it('runs pieces concurrently up to the cap, results in piece order', async () => {
    let live = 0; let peak = 0;
    const { results, receipts } = await mapPieces({
      pieces: ['a', 'b', 'c', 'd', 'e'],
      budget: 100,
      concurrency: 2,
      attempt: async (p) => {
        live++; peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 10));
        live--;
        return p.toUpperCase();
      },
      floor: async () => 'FLOOR',
    });
    expect(results).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(peak).toBeLessThanOrEqual(2);
    expect(receipts.every((r) => r.outcome === 'ok')).toBe(true);
  });

  it('retries once with the rejection message, then floors with a diagnosed class', async () => {
    const attempts: (string | undefined)[] = [];
    const { results, receipts } = await mapPieces({
      pieces: ['x'.repeat(10)],
      budget: 100,
      attempt: async (_p, rejection) => { attempts.push(rejection); throw new Error('schema rejected'); },
      floor: async (_p, cls, reason) => `floored:${cls}:${reason}`,
    });
    expect(attempts).toEqual([undefined, 'schema rejected']); // retry carried the why
    expect(results[0]).toBe('floored:weak-output:schema rejected');
    expect(receipts[0]).toMatchObject({ outcome: 'floored', class: 'weak-output' });
  });

  it('an oversize piece floors as overflow', async () => {
    const { receipts } = await mapPieces({
      pieces: ['y'.repeat(500)],
      budget: 100,
      attempt: async () => { throw new Error('cut off'); },
      floor: async () => 'floored',
    });
    expect(receipts[0].class).toBe('overflow');
  });

  it('transport failure rejects the whole map — queues must retry later, not consume', async () => {
    await expect(mapPieces({
      pieces: ['a'],
      budget: 100,
      attempt: async () => { throw new TypeError('fetch failed'); },
      floor: async () => 'never',
    })).rejects.toThrow(/fetch failed/);
  });
});
```

- [ ] **Step 2: Run — the four new tests fail ("mapPieces is not a function")**

- [ ] **Step 3: Implement**

```ts
// append to src/server/pipeline.ts
export interface PieceReceipt {
  piece: number;
  outcome: 'ok' | 'floored';
  reason?: string;
  class?: PipelineFailureClass;
}

/** The ladder, per piece: one attempt, one rejection-retry (the rails recipe), then the
 * consumer's floor with a DIAGNOSED class. Transport rejects the whole map — a dead endpoint
 * would floor every piece into fallback content during an outage, which is exactly the
 * "consumed the entry with undistilled content" bug the old compile ladder guarded against. */
export async function mapPieces<T>(opts: {
  pieces: string[];
  budget: number;
  concurrency?: number;
  attempt: (piece: string, rejection?: string) => Promise<T>;
  floor: (piece: string, cls: PipelineFailureClass, reason: string) => Promise<T>;
}): Promise<{ results: T[]; receipts: PieceReceipt[] }> {
  const results: T[] = new Array(opts.pieces.length);
  const receipts: PieceReceipt[] = new Array(opts.pieces.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= opts.pieces.length) return;
      const piece = opts.pieces[i];
      try {
        results[i] = await opts.attempt(piece);
        receipts[i] = { piece: i, outcome: 'ok' };
      } catch (first) {
        if (isTransportFailure(first)) throw first;
        const firstMsg = first instanceof Error ? first.message : String(first);
        try {
          results[i] = await opts.attempt(piece, firstMsg);
          receipts[i] = { piece: i, outcome: 'ok' };
        } catch (second) {
          if (isTransportFailure(second)) throw second;
          const reason = (second instanceof Error ? second.message : String(second)).slice(0, 160);
          const cls = classifyFailure(second, piece.length, opts.budget);
          results[i] = await opts.floor(piece, cls, reason);
          receipts[i] = { piece: i, outcome: 'floored', reason, class: cls };
        }
      }
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? 4, opts.pieces.length));
  await Promise.all(Array.from({ length: n }, worker));
  return { results, receipts };
}
```

- [ ] **Step 4: Run tests — green. Also `npm run typecheck`.**

- [ ] **Step 5: Commit** — `git commit -am "feat: pipeline mapPieces — bounded-parallel retry ladder with diagnosed floors"`

---

### Task 3: config — per-role contextTokens + concurrency knobs

**Files:**
- Modify: `src/server/config.ts` (the per-role model schema — find `rails` on the tutor role for the pattern)
- Test: `tests/config.test.ts` (follow existing config tests' shape)

**Interfaces:**
- Produces: `cfg.models.<role>.contextTokens?: number`, `cfg.models.<role>.concurrency?: number` — read by compile refit (Task 4) as `budgetChars(cfg.models.compile.contextTokens)` and `cfg.models.compile.concurrency ?? 4`.

- [ ] **Step 1: Failing test** — extend the existing config parse test file:

```ts
it('per-role contextTokens and concurrency parse and default to undefined', () => {
  const cfg = loadConfigFrom({ models: { compile: { model: 'ollama:x', contextTokens: 32768, concurrency: 2 } } });
  expect(cfg.models.compile.contextTokens).toBe(32768);
  expect(cfg.models.compile.concurrency).toBe(2);
  expect(cfg.models.tutor.contextTokens).toBeUndefined();
});
```

(Adapt the construction call to the file's existing helper — the config tests already build partial configs; copy their pattern exactly.)

- [ ] **Step 2: Run — fails (unknown key stripped or type error).**

- [ ] **Step 3: Implement** — in the role schema object in `config.ts` add:

```ts
// Both serve the small-model pipeline (spec 2026-07-31 §6): contextTokens caps what one call
// may carry (budgetChars), concurrency caps the parallel map — VRAM respect, not a speed knob.
contextTokens: z.number().int().positive().optional(),
concurrency: z.number().int().positive().optional(),
```

- [ ] **Step 4: Run config tests + typecheck — green.**

- [ ] **Step 5: Commit** — `git commit -am "feat: per-role contextTokens and concurrency config knobs"`

---

### Task 4: compile refit — engine-driven parallel distillation

**Files:**
- Modify: `src/server/ingest.ts` (`compileOne` part loop ~707-763, `weakCompileFallback` ~590-634)
- Test: `tests/mineRepo.test.ts` untouched; compile behavior tests live in `tests/ingest*.test.ts` / wherever `compileOne` is currently pinned — extend that file (grep `compileOne(` in tests to find it).

**Interfaces:**
- Consumes: `mapPieces`, `budgetChars`, `classifyFailure` (Tasks 1-2); knobs (Task 3).
- Produces: `weakCompileFallback` gains a `reason` in its return: `Promise<{ how: 'distilled' | 'verbatim'; reason?: string }>` — Task 5's ledger text relies on it.
- Behavior contract:
  1. Part 1 always tries the agentic loop first (unchanged).
  2. If part 1 wrote pages agentically → remaining parts continue the SEQUENTIAL agentic loop, exactly as today (slug-refresh semantics preserved; strong models see zero change).
  3. If part 1 fell back → the remaining parts skip the doomed agentic attempts and run `mapPieces` distillation in parallel (`concurrency` knob), each piece through `weakCompileFallback`, floors included.
  4. `chunkChapter(chapterMarkdown, Math.min(chunkChars, budgetChars(cfg.models.compile.contextTokens)))` — the fit check enters the split.

- [ ] **Step 1: Failing test** — in the file that pins `compileOne` (find with `grep -rn "compileOne" tests/`):

```ts
it('a weak model distills remaining parts in parallel after part 1 falls back', async () => {
  // A 3-part chapter (force small chunkChars). The fake model NEVER calls write_page
  // agentically (empty text turns) but answers every distillation with valid JSON.
  const calls: { kind: string; at: number }[] = [];
  let clock = 0;
  const model = streamModel(async (req) => {
    const prompt = JSON.stringify(req.messages);
    if (prompt.includes('Distill this chapter part')) {
      calls.push({ kind: 'distill', at: clock++ });
      return { text: JSON.stringify({ title: `T${calls.length}`, body: 'A page body of enough words to be a page.' }) };
    }
    calls.push({ kind: 'agentic', at: clock++ });
    return { text: 'I cannot call tools.' };
  });
  const entry = mkQueueEntry(/* 3-part chapter fixture, copy the file's existing helper */);
  const result = await compileOne(lw, cfgWith({ compile: { model: 'ollama:weak', concurrency: 3 } }), model, entry, 500);
  expect(result).toBe('compiled');
  // Exactly ONE agentic attempt (part 1) — parts 2..n skipped the doomed loop.
  expect(calls.filter((c) => c.kind === 'agentic')).toHaveLength(1);
  // All three parts produced pages (distilled), verifiable via lw.listSlugs().
  expect((await lw.listSlugs()).filter((s) => s.startsWith('t'))).toHaveLength(3);
});
```

(Adapt fixture helpers to the test file's own; the assertions above are the contract.)

- [ ] **Step 2: Run — fails: today every part attempts agentically (3 agentic calls).**

- [ ] **Step 3: Implement** — inside `compileOne`, restructure the part loop:

```ts
const budget = Math.min(chunkChars, budgetChars(cfg.models?.compile?.contextTokens));
const chunks = chunkChapter(chapterMarkdown, budget);
// ... citation wrapper unchanged ...
let agenticAlive = true; // flips off the moment a part proves the model can't drive tools
for (let i = 0; i < chunks.length && agenticAlive; i++) {
  // existing sequential agentic body, EXCEPT: where today it calls `await fallback()` /
  // `await fallback(msg)`, it now sets `agenticAlive = false` and breaks, remembering i.
}
if (!agenticAlive) {
  // Parts i..end: harness-driven parallel distillation. Slugs snapshot once — distillation
  // never links, so the per-part refresh the agentic loop needs does not apply here.
  const slugs = new Set(await lw.listSlugs());
  const rest = chunks.slice(firstFallbackPart);
  const { receipts } = await mapPieces({
    pieces: rest,
    budget,
    concurrency: cfg.models?.compile?.concurrency ?? 4,
    attempt: async (piece, rejection) => distillPart(piece, rejection, /* existing distillOnce+write path */),
    floor: async (piece, cls, reason) => writeVerbatim(piece, cls, reason), // Task 5 wires the label
  });
  receipts.forEach((r, k) => {
    const n = firstFallbackPart + k + 1;
    if (r.outcome === 'ok') { wroteAny = true; partNotes.push(`part ${n}: distilled`); }
    else { wroteAny = true; partNotes.push(`part ${n}: verbatim (${r.class}: ${r.reason})`); }
  });
}
```

Refactor `weakCompileFallback` into the two halves this needs (`distillPart` = distill+write with one retry handled by mapPieces — so REMOVE its internal second `distillOnce` try; the engine owns the retry now; `writeVerbatim` = the floor write, taking `cls`/`reason` for the label). Keep transport re-throws intact.

- [ ] **Step 4: Run the compile test file + full `npx vitest run` — the old sequential-ladder tests will need their expectations updated to the new notes format; update them in the same commit (they are pinning the ladder this task deliberately changes).**

- [ ] **Step 5: Commit** — `git commit -am "feat: compile rides the pipeline engine — parallel distillation after first fallback"`

---

### Task 5: diagnosed ledger notes + verbatim label

**Files:**
- Modify: `src/server/ingest.ts` (verbatim page banner + partNotes text — mostly done structurally in Task 4; this task pins wording)
- Test: same compile test file

**Interfaces:**
- Ledger phase/notes format (Plan 2 and the library UI read these strings):
  - distilled part: `part 3: distilled`
  - floored part: `part 3: verbatim (weak-output: schema rejected twice)`
  - verbatim page banner first line: `> Compiled verbatim (weak-output): the compile model could not distill this part…`

- [ ] **Step 1: Failing test**

```ts
it('a verbatim part names its diagnosed class in the ledger note and the page banner', async () => {
  const model = streamModel(async () => ({ text: 'not json at all' })); // distill always rejects
  const entry = mkQueueEntry(/* 1-part chapter */);
  await compileOne(lw, cfgWith({ compile: { model: 'ollama:weak' } }), model, entry, 500);
  const q = readQueue(vault).find((e) => e.chapter === entry.chapter);
  expect(q?.phase ?? q?.error ?? '').toMatch(/verbatim \(weak-output:/);
  const page = await lw.call('read_page', { slug: /* the verbatim slug */ });
  expect(page.page.body).toMatch(/^> Compiled verbatim \(weak-output\):/);
});
```

- [ ] **Step 2: Run — fails on the old unlabeled wording.**

- [ ] **Step 3: Implement** — thread `cls` into the banner and notes (Task 4 left the seams).

- [ ] **Step 4: Run file + full suite — green.**

- [ ] **Step 5: Commit** — `git commit -am "feat: verbatim compile floors carry their diagnosed reason"`

---

### Task 6: MOC merge — one hub page per multi-part chapter

**Files:**
- Modify: `src/server/ingest.ts` (end of `compileOne`, after the part loop, before the `!wroteAny` check)
- Test: same compile test file

**Interfaces:**
- Consumes: `writtenSlugs` (already collected in order by the citation wrapper), `generateStructured`, `lw.call('link_pages', { src, dst, type: 'deepens' })`.
- Behavior: when a chapter wrote **more than one** page, write a hub page:
  - slug `${slugify(entry.book)}-ch-${chapterN}-moc` (freshSlug collision rule applies)
  - title `${entry.title} — map of content`
  - body: model-written 2-3 sentence chapter overview (one `generateStructured` call, schema `{ overview: z.string().min(1) }`), floor = empty overview; then a deterministic ordered list: `- [[slug]]` per written page, reading order.
  - `status: 'draft'`, sources: the chapter citation (rides the wrapper automatically).
  - After writing: `link_pages` each part → MOC with type `deepens` (parts go deeper than the hub).
  - Single-page chapters: no MOC, no calls — nothing to map.

- [ ] **Step 1: Failing test**

```ts
it('a multi-part chapter gets a MOC hub linking every part in order, parts deepen it', async () => {
  const model = streamModel(async (req) => {
    const p = JSON.stringify(req.messages);
    if (p.includes('Distill this chapter part')) return { text: JSON.stringify({ title: `Part ${++n}`, body: 'Body words.' }) };
    if (p.includes('chapter overview')) return { text: JSON.stringify({ overview: 'What this chapter covers.' }) };
    return { text: 'no tools' };
  });
  let n = 0;
  const entry = mkQueueEntry(/* 3-part chapter */);
  await compileOne(lw, cfgWith({ compile: { model: 'ollama:weak' } }), model, entry, 500);
  const moc = await lw.call('read_page', { slug: expect.stringMatching(/-moc$/) /* fetch via listSlugs find */ });
  expect(moc.page.body).toMatch(/What this chapter covers/);
  expect(moc.page.body.match(/\[\[part-\d/g)).toHaveLength(3);         // ordered [[links]]
  const part1 = await lw.call('read_page', { slug: 'part-1' });
  expect(part1.page.meta.deepens).toContain(/* the moc slug */);        // graph edge landed
});
```

(Resolve the MOC slug via `(await lw.listSlugs()).find((s) => s.endsWith('-moc'))` — exact code in the test file.)

- [ ] **Step 2: Run — fails (no MOC written today).**

- [ ] **Step 3: Implement** — after the part loop in `compileOne`:

```ts
// The MOC (Obsidian map-of-content): the chapter's one hub, linking every page it produced in
// reading order. Deterministic list + one small overview call with an empty-string floor — the
// hub must exist even when the model can't write prose. Single-page chapters skip it: a map of
// one place is noise.
if (writtenSlugs.length > 1 && writePage) {
  let overview = '';
  try {
    const { object, usage } = await generateStructured({
      model,
      prompt: `Write a 2-3 sentence chapter overview for "${entry.title}" of "${entry.book}", `
        + `covering these pages: ${writtenSlugs.join(', ')}. Plain prose, no links, no headings.`,
      schema: z.object({ overview: z.string().min(1) }),
      schemaName: 'chapter_overview',
    });
    recordUsage(cfg.vault, { role: 'compile', model: cfg.models?.compile?.model ?? 'unknown', usage });
    overview = object.overview;
  } catch (e) {
    if (isTransportFailure(e)) throw e;
    // weak-output floor: the list below IS the map; prose was garnish.
  }
  const mocSlug = freshSlug(`${entry.book} ch ${chapterN} moc`, new Set(await lw.listSlugs()));
  await writePage({
    slug: mocSlug,
    title: `${entry.title} — map of content`,
    body: `${overview ? `${overview}\n\n` : ''}${writtenSlugs.map((s) => `- [[${s}]]`).join('\n')}`,
    status: 'draft',
  });
  for (const s of writtenSlugs.filter((s) => s !== mocSlug)) {
    await lw.call('link_pages', { src: s, dst: mocSlug, type: 'deepens' });
  }
}
```

- [ ] **Step 4: Run file + full suite + `npm run typecheck` — green.**

- [ ] **Step 5: Commit** — `git commit -am "feat: multi-part chapters compile to a map-of-content hub"`

---

### Task 7: end-to-end proof — weak-model CI ladder + live check

**Files:**
- Modify (if wording drifted): `tests/llm/weakModel.integration.test.ts`
- No new code.

- [ ] **Step 1: Run the weak-model integration suite** — `npx vitest run tests/llm` — it drives the REAL wire against the deliberately broken fake (`weak-model-server.mjs`), including reject-rf. Fix any pinned ladder wording the refit changed; behavior invariants (never a learner-facing error; transport retries) must hold unchanged.

- [ ] **Step 2: Full verify** — `npm run typecheck && npx vitest run && npx playwright test --reporter=list` — all green.

- [ ] **Step 3: Live smoke (browser-verify skill)** — scratch stack on a small ollama model, ingest a 3-section markdown file, watch the ledger reach `done`, confirm part pages + `-moc` page in the library, MOC links clickable. Screenshot.

- [ ] **Step 4: Commit any test-wording fixes** — `git commit -am "test: pin the engine-era compile ladder wording"`

---

## Self-review (done at write time)

- **Spec coverage:** §1 fit math (T1), split (existing `chunkChapter` reused, budget-fed — T4), parallel map (T2/T4), retry (T2), diagnosed classes (T1/T5), merge (T6), floor labeling (T5); §2 MOC + untouched agentic path (T4/T6); §4 sources ride the citation wrapper unchanged (T4 note); §7 offline tests (T1-T6), weak-model CI (T7). Vote deferred to Plan 2 — recorded in header.
- **Placeholders:** fixture helpers are referenced by pattern ("copy the file's existing helper") because the exact helper names live in a test file the implementer greps in Task 4 Step 1 — the assertions are complete.
- **Type consistency:** `mapPieces`/`budgetChars`/`classifyFailure`/`PieceReceipt` names identical across tasks; `weakCompileFallback`'s split into `distillPart`/`writeVerbatim` named consistently in T4/T5.
