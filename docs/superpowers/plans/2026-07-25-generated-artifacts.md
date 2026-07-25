# 2026-07-25 — Compiler-authored gap artifacts: removing the per-artifact hand-authoring bottleneck

**Status:** plan only. Nothing in section B is implemented; section A landed in `d479f91`/this branch.

## Why

North star: this repo should help someone learn anything. The knowledge side already generalises —
ingest compiles books, papers and repos into concept pages, and every graph query and the student
model carry no domain knowledge. Applied *practice* was the gap, and it had two layers:

1. **No applied block outside three subjects.** Fixed — `structured_check` (five mechanical checkers)
   plus multivariate `mathEquivalent`. See section A.
2. **The coding path does not scale even within programming.** Not fixed. Practising a second
   pattern requires hand-authoring an entry in each of five places.

This plan is about (2).

## The bottleneck, precisely

| Where | Keyed by | Artifacts covered |
| --- | --- | --- |
| `handWrittenProse.ts` `PLAN_CONCEPTS_BY_ARTIFACT` | artifactId | 1 |
| `handWrittenProse.ts` `PREDICT_ITEMS_BY_ARTIFACT` | artifactId | 1 |
| `handWrittenProse.ts` `DOC_CARDS_BY_ARTIFACT` | artifactId | 1 |
| `handWrittenProse.ts` `PROBLEM_SPEC_BY_ARTIFACT` | artifactId | 1 |
| `failureMessages.ts` `streamConsumerMessages` | failing test-name set | 1 |
| `seedPatternPages.ts` `PATTERN_PAGES` | pattern slug | 1 |
| the-gap `packages/artifacts` | artifactId | (not in this repo) |

All of them are `stream-consumer`. An artifact without entries still *works* — editor, real tests,
grading, evidence — but loses the plan/predict/docs offers, the problem spec, and its proximity
message. The scaffolding is what makes it teaching rather than an exercise dump.

Partly mitigated already (section A): `proximityMessage` now derives a message from the suite's own
test names instead of emitting a bare count, so a new artifact gets *something* real.
`PROBLEM_SPEC_BY_ARTIFACT` is absent-safe. Neither removes the authoring need.

## The constraint that makes this hard

The gap's principle — *"LLMs never decide … those live in hand-written templates"* — is exactly what
makes its `applied-correctly` evidence trustworthy. Generating the scaffolding with a model appears to
violate it.

The resolution is to separate **authoring** from **grading**:

- A model MAY author what is *checkable or discardable*: the problem statement, the scaffold, the
  plan concepts, the doc cards, and candidate tests.
- A model MUST NOT be what *decides* whether the learner passed. That stays the real suite, run by
  the sidecar.

This is the same seam `structured_check` already uses (a model writes the question; arithmetic grades
it) and the same seam `mathEquivalent` uses. So the principle survives if — and only if — generated
tests are themselves verified before they are ever used to grade a learner.

## A. Landed

- `mathEquivalent` is multivariate with detected free variables; `\div` regression fixed.
- `structured_check`: numeric / set / sequence / matching / pattern, mechanically graded, tutor
  prompt rule 11a.
- `proximityMessage` derives from test names for any artifact.

## B. Not started — generated artifacts

- [ ] **B1. Artifact bundle format, harness-side.** Define what the harness can emit without the-gap:
      `vault/.harness/artifacts/<id>/{meta.json, artifact.ts, artifact.test.ts, scaffold.json}`, the
      same shape `ingestRepo`'s mining pass already produces for mined artifacts (so the-gap's
      existing `GAP_EXTRA_STORES` boot-load picks it up with no sidecar change). **Open question:**
      the exact on-disk contract lives in the-gap's `packages/artifacts` and is not readable from
      this repo — confirm against it before writing any emitter.

- [ ] **B2. The self-verification gate — the crux, do this before any UI.** A generated artifact is
      only admissible if, mechanically:
      1. the reference solution passes 100% of the generated tests;
      2. a deliberately broken mutation of the reference FAILS at least one test (a suite that passes
         everything grades nothing — this is the check that would have caught a vacuous suite);
      3. the answer-stripped scaffold does NOT pass (otherwise the exercise is already solved);
      4. every test name is a requirement, not a hint containing the answer.
      Reject the artifact if any gate fails; never surface an unverified one. Log rejections with the
      failing gate so the compile step is debuggable.

- [ ] **B3. Authoring from a compiled source.** The `compile` role already reads a chapter and writes
      concept pages. Extend it, for pages tagged as programming patterns, to also propose an artifact
      bundle, then run B2 over it. Reuse the existing ledger/queue machinery — an artifact that fails
      B2 is a normal queue failure, not a special case.

- [ ] **B4. Generic scaffolding from the bundle.** Once a bundle exists, derive what is currently
      hand-authored: problem spec from the bundle's statement, plan concepts from its test names,
      doc cards from the imports/APIs it uses. Hand-written entries keep winning where present.

- [ ] **B5. Retire `PATTERN_PAGES` as a hardcoded list.** Seed a vault page per artifact discovered on
      disk instead of per hardcoded entry, keeping `seedPatternPages`'s write-once idempotence and its
      single-writer route through `lw.call('write_page', …)`.

## Risks

- **A vacuous generated suite mints false mastery.** This is the whole risk. B2 gate 2 (mutation must
  fail) is the specific defence and must not be skipped for convenience.
- **Answer leakage through test names.** B2 gate 4. The stand-in's experience is instructive here: it
  took rendering the thing in a browser to notice a malformed scaffold, so review generated output
  visually, not only programmatically.
- **Drift from the-gap's real artifact format.** B1's open question. Anything built before confirming
  it is speculative.
- **Scope creep into the-gap itself.** That repo is not reachable from this environment and every port
  comment marks it READ ONLY. Everything above is harness-side or on-disk-contract work.
