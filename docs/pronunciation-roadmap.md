# Pronunciation & tone: what's shipped, and the grading path

A live Vietnamese sitting named a real gap: a text tutor can teach the tone *map* — which
diacritic is which tone, how `má` (rising) contrasts with `mà` (falling) — but until now it could
never let the learner **hear** the difference, and it still can't **grade** their production. This
splits into two capabilities. The first is shipped; the second is designed here against real
open-source components, deliberately not half-wired (the app's own rule: no phantom capabilities).

## Shipped: hearing the tones (`speak` UI tool)

`src/shared/uiTools.ts` → `src/client/components/blocks/Speak.tsx`. The tutor attaches a "hear
this" control to any word/phrase with a BCP-47 language tag; the client speaks it through the
**Web Speech API** (`window.speechSynthesis`), which ships inside Electron/Chromium with **zero
dependencies**. Navigation-class like `open_source` — hearing a word mints no evidence. Honestly
gated: if the OS has no voice for the language, the chip says "no vi voice on this device — use a
native recording" rather than mispronouncing Vietnamese in a US-English voice, and the
availability receipt travels back so the tutor can adapt (verified live — it pointed the learner
to native-audio guides and pivoted to spelling checks it *could* verify).

**Reference-quality audio, if the OS voice is poor or absent:** [Piper](https://github.com/OHF-Voice/piper1-gpl)
(Open Home Foundation, VITS + ONNX, embeds espeak-ng for phonemization) has Vietnamese voices and
runs fully local — a natural `extraResources` bundle if we want guaranteed audio independent of
the host's installed voices. [eSpeak NG](https://github.com/espeak-ng/espeak-ng) is lighter and
covers 100+ languages but sounds robotic. (Coqui TTS was sunset in 2024; community forks work but
it's no longer first-choice.)

## Designed: grading a learner's pronunciation (the tone-contour checker)

This is the exciting one because it fits the app's **mechanical-grading thesis exactly**.
Vietnamese tones *are* pitch (F0) contours: `sắc` rises, `huyền` falls, `hỏi` dips then rises,
`ngã` rises with a glottal break. So a learner's tone can be graded the same honest way a numeric
answer is — by comparison against a template, no model opinion.

Pipeline (all open-source, all local-capable):

1. **Capture** the learner's utterance in the browser — `MediaRecorder`, already available in
   Electron. No new native dependency for the recording half.
2. **Extract the F0 contour** from the recording. Two proven options:
   [CREPE / torchcrepe](https://github.com/marl/crepe) (CNN on the raw waveform, state-of-the-art
   monophonic pitch — [Kim et al. 2018](https://arxiv.org/abs/1802.06182)), or classic DSP via
   `librosa`'s pYIN / [Parselmouth-Praat](https://github.com/YannickJadoul/Parselmouth) (the
   phonetics gold standard for F0 and voice-quality features). CREPE is heavier but more robust on
   noisy mic input; pYIN needs no model download.
3. **Normalize** the contour — median-subtract in semitones so it's speaker-pitch-independent, and
   time-normalize to the syllable so speaking rate doesn't matter (the same shape-not-magnitude
   idea already used elsewhere: cf. the σ√dₖ intuition, or the residual-ratio equation grader).
4. **Grade** by correlating the normalized contour against the reference tone template. A
   correlation above threshold is a mechanical pass → `applied-correctly` evidence; below is
   `struggled` with the specific miss named ("you fell where `ngã` rises"). This is a genuine new
   `structured_check` checker kind (`tone_contour`), sitting beside `numeric`/`chem_equation`.

### Why it isn't wired yet

The grading half needs a pitch-analysis service (CREPE is Python/ONNX; pYIN is Python) — a new
runtime dependency and a mic-capture UX, which is a feature-sized build, not a session's audit
fix. Wiring it half-way would violate the very honesty rule that made `speak` degrade loudly. The
design is committed here so the next builder starts from grounded components, not a blank page.

**Prior art for non-tone languages:** [speechocean762](https://www.researchgate.net/publication/354221406)
is an open corpus for phoneme/word/sentence pronunciation scoring, and CMUSphinx documented an
HMM-alignment pronunciation evaluator — both relevant if the checker later expands past tone to
segmental accuracy.
