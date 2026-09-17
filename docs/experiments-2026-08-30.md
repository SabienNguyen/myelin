# Live experiments, 2026-08-30

Run after the audit fixes landed (typecheck clean, vitest 1872/0). Server on the fixed tree,
scratch vault and student `experiment`, real model routes: `openai:gpt-5.6-luna` for turns 1–4,
`ollama:qwen3-tutor-32k` + `ollama:qwen-grader-32k` for turns 5–7. Driven in a headed Chromium
with Playwright; no scripted mock. Nothing touched the real vault or `~/.config/myelin`.

## What happened

| # | Model | Action | Outcome | Time |
|---|---|---|---|---|
| 1 | gpt-5.6-luna | "Teach me how backpropagation works" on an empty vault | Searched vault, wrote `backpropagation.md`, recorded `exposed`, staged a writing exercise with a 3-point rubric. No teaching prose in the transcript. | 12s, 49k in / 787 out |
| 2 | gpt-5.6-luna | Submitted the writing exercise blank | `no draft was submitted`, `struggled` evidence, tutor offered a skeleton instead of grading nothing | 5s |
| 3 | gpt-5.6-luna | Explanation with a planted misconception (backprop *is* the optimizer) plus correct delta equations | Misconception recorded verbatim, `struggled` with a fair note, revision exercise names the exact error and keeps what was right | 9s |
| 4 | gpt-5.6-luna | Corrected revision | Rubric 3/3 with quoted evidence per criterion, misconception resolved, level `exposed → practicing` (capped: model-graded) | ~20s |
| 5 | qwen3-tutor-32k | "Yes, give me the tiny network" | Staged a `math_scratchpad` with a concrete scalar network | 8s, 13.7k in / 328 out |
| 6 | qwen3-tutor-32k | Submitted the scratchpad (driver could not type into the mathfield, so it went in empty) | `final differs from expected`, `struggled`, level `practicing → exposed` | 5s |
| 7 | qwen3-tutor-32k | Told the tutor its answer key was wrong, with the right numbers | No reply text. Re-staged the problem with a corrected key. Never acknowledged the error. | 7s |

## Findings, most important first

**1. The local model wrote a wrong answer key and the checker enforced it.** Block 5's
`expectedLatex` was `ŷ=22, L=72, 24, 12, 96, 48`; the correct values for the stated network are
`ŷ=26, L=128, 112, 16, 128, 64` (it dropped `b1`). `math_scratchpad` grading is mechanical
against that key, and `struggled` demotes one rung (`engram model.ts:227`). A learner who
answers correctly is graded wrong and demoted, and the record says they struggled. When
challenged, the tutor fixed the key in the next block without saying so (turn 7), so the bad
`struggled` row stays. Keys authored by a small model are unverified; nothing in the pipeline
checks a numeric key before it becomes ground truth. Options: have the server verify numeric
keys by evaluation where the problem is fully specified, require a worked derivation in the
block args and check consistency, or send keys from `ollama:` tutors through the grader role
before staging.

**2. `gpt-5.6-luna` emitted a terminal escape inside a page body and the server wrote it.**
`pages/backpropagation.md` contains `$\x1b[200~\hat y=g(z_2)$` (bracketed-paste start). It is in
the model's own `write_page` arguments in `sessions/default.json`. `scrubModelArtifacts` runs
client-side only; page writes go to disk verbatim. Fix: strip C0 controls (except `\n`, `\t`) from
`body`/`title` in the `write_page` sanitizer.

**3. A blank math answer reads as a wrong attempt.** Turn 6 shows `You:` with nothing after it
and the verdict `final differs from expected`. `writing_draft` says `nothing submitted` for the
same situation. `grading.ts:~636` should special-case an empty final the way the draft path does.

**4. No teaching before testing.** Turn 1's transcript is four tool chips and an exercise; the
page it wrote sits in the Page tab, unmentioned. The learner asked to be taught. Whether the
tutor should say anything first is a prompt decision, but the transcript as shipped gives a
new learner nothing to read.

**5. Local tutor answers with blocks only.** Turns 5 and 7 produced zero prose, including when
asked a direct question. Likely a prompt/format-following limit of `qwen3-tutor-32k`; worth a
rail that requires at least one sentence when the user message ends in a question mark.

**6. Grammar checker flags math tokens.** The mechanical style pass on the draft flagged `dL`,
`dW2`, `delta2`, `a1` as spelling errors with fixes "do", "dab", "delta", "a". Skip tokens
that match `[A-Za-z]+\d+|d[A-Z]\w*` or sit inside inline math.

**7. Guardrail fired on turn 2.** `guardrail.log`: `record_evidence named pages this turn never
read, staged or wrote: backpropagation`. The graded block was staged the previous turn; the
guardrail's notion of "this turn" does not count a block graded in it. Either the message is
misleading or the check is too narrow.

**8. Cost profile.** First `gpt-5.6-luna` turn: 49k input tokens (36k cache read). Every turn
carries the full system prompt plus vault context. The history diet fix from the audit helps
later turns; the floor is the prompt itself.

## What worked

Blank-submission guard, misconception record → surface → repair → resolve loop, rubric grading
with quoted evidence, capped model evidence (`practicing`, not `mastered`), honest page
sourcing ("Unverified model knowledge; no web search tool was available"), live model switch
without restart, graph decay ring, loopback bind, zero console errors across seven turns.

## Artefacts

Screenshots and the scratch vault are under the session scratchpad
(`exp1.png` … `exp7.png`, `exp-graph.png`, `experiment-vault/`). The server and the driven
browser were left running on `127.0.0.1:4820` for you to continue; stop with the pids from
`ss -ltnp | grep 4820` and the `.live-driver.mjs` node process, then delete `.live-driver.mjs`.
