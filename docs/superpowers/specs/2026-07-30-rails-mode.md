# Rails mode: a harness-driven loop for small models

The agentic tutor loop asks a lot of a model: pick the next thing to teach across a whole vault,
drive a dozen tools, stage blocks, remember to record evidence. Strong models handle it; small
local models (the reason `ollama:` routes exist) reliably don't — they wander, hallucinate tool
arguments, and skip record_evidence. Rails mode inverts control: THE HARNESS decides what happens
next and the model does only narrow generation. That trades the tutor's open-ended judgment for
determinism a 8-14B model can ride.

## Phase 1 scope (this spec): review-and-drill sessions, quick_check only

A rails turn never gives the model tools. The loop:

1. **Plan** (harness, deterministic): `working_set` (engram) gives the recently-exercised region
   with decay flags; `next_lessons` gives review-due + frontier. The item picker takes, in order:
   due working-set members (most overdue first), then next_lessons suggestions, then working-set
   neighbors never exercised. One item per turn.
2. **Assemble** (harness, deterministic): read_page on the item, trim body to a fixed budget,
   plus the student's level for it and up to 2 find_analogies bridges. This — not the
   conversation history — is the model's whole context. History rides only as the last few
   user/assistant text exchanges (fixed cap), so a rails session's prompt size is bounded and
   cache-stable.
3. **Generate** (model, narrow): one `generateStructured` call — "write a quick_check for THIS
   page at THIS level" with a schema of {question, mode: 'choice', choices[3-5], expected,
   framing}. The framing line enforces the prompt rules (calibration framing on first contact).
   Validation failures throw; the harness retries once with the error appended, then falls back
   to a template question from the page's own headings — a rails session never dies on a
   malformed generation.
4. **Stage** (harness): the block goes out over the wire as a synthetic tool part
   (tool-input-available with a harness-minted toolCallId) followed by one short framing text.
   The client renders it exactly like a model-staged block; the turn pauses.
5. **Grade + record** (harness, on resubmit): machine grading as today (gradeBlockOutput), then
   THE HARNESS calls record_evidence itself via lw.call — the model cannot forget it, so the
   evidence guardrail is structurally unnecessary on rails turns. capApplied and every evidence
   invariant hold because it is the same grading path.
6. **Feedback** (model, narrow): one generateStructured call — {feedback (≤2 sentences, honesty
   rules: describe only what the student did), next: 'continue' | 'stop-offer'} — then the loop
   plans the next item.

## Where it lives

- `src/server/rails.ts` — plan/assemble/stage/feedback, driven from session.ts's respond() when
  rails is active. The wire layer needs nothing new (createUiStream already takes raw writes).
- Config: `models.tutor.rails: true` opts a setup into rails for learn/review/quiz modes;
  freeform always runs the full agentic loop (writing pages needs real tool use). The models
  dialog shows a "rails" checkbox beside the tutor id. Default OFF everywhere.
- The scripted e2e model drives a rails session end to end: plan → staged quick_check → answer →
  harness-recorded evidence, asserted in the vault exactly once.

## Invariants

- Evidence semantics byte-identical: same grading, same record_evidence arguments the model
  would have sent, `source` still the machine grade's own. Rails changes WHO calls, never WHAT.
- Prompt rules still bind: the generation schema carries framing/honesty constraints from
  tutor-system-prompt.md's rules 3/3a — rails is not an excuse to quiz without framing.
- Full-loop parity elsewhere: rails off = zero behavior change (the flag gates the only branch).
- Later phases (not now): structured_check and label_diagram items, misconception re-probes,
  rabbit-hole offers ("deepens" links as a choice block), voice/style pass-through.
