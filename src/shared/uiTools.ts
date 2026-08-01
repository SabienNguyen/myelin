// Frontend tools that DRIVE THE UI rather than collect graded work. Same transport as blocks
// (no server execute; the client renders the call and supplies the output), but deliberately not
// in BLOCK_TOOLS: nothing here is graded, mints evidence, or counts toward block coverage.
import { z } from 'zod';

export const UI_TOOLS = {
  // The librarian's second hand: after routing the learner to an artifact, BRING them to it.
  open_source: {
    input: z.object({
      /** The source's ledger title (or a distinctive part of it) — resolved client-side against
       *  the ingest queue, so the tutor names artifacts the way the Library shows them. */
      title: z.string(),
    }),
    result: z.object({
      opened: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  // A one-click "write this up" button for the case where nothing has unlocked writing and the
  // learner has not asked for it — something simply came out of the conversation worth keeping.
  // The button arms a one-shot write and the server promotes just that turn to freeform.
  //
  // Narrower than it once was. Writing now unlocks on a vault gap (session.ts's vaultGap), and an
  // explicit "save that" derives to freeform on its own (deriveMode.ts) — in both of those the
  // tutor writes the page instead of offering. Offering a button to someone who already asked is
  // making them ask twice. Navigation-class, never graded.
  offer_write: {
    input: z.object({
      /** What the page would be called — shown on the button ("Write “Vietnamese tones” up"). */
      title: z.string(),
      /** Optional one-line reason, shown under the button ("so your progress here sticks"). */
      why: z.string().optional(),
    }),
    result: z.object({
      requested: z.string().optional(),
    }),
  },
  // Attach a "hear this" control to a word or phrase, spoken by the browser's own speech engine
  // (Web Speech API — in Electron/Chromium already, zero deps). Built for the tone languages a
  // text-only tutor could teach the MAP of but never let the learner HEAR (a live Vietnamese
  // sitting named exactly this gap). Navigation-class, never graded: hearing a word is not
  // evidence you can produce it. Honestly gated client-side — no voice for the language, no
  // fake playback in the wrong accent (the app's degrade-loudly rule).
  speak: {
    input: z.object({
      /** The exact text to speak — a syllable, word, or short phrase in the target language. */
      text: z.string(),
      /** BCP-47 language tag picking the voice (e.g. "vi" or "vi-VN" for Vietnamese, "zh-CN",
       *  "ja-JP"). The client matches it against the OS's installed voices. */
      lang: z.string(),
      /** Optional gloss shown beside the control ("ma = ghost") so the button teaches in place. */
      gloss: z.string().optional(),
    }),
    result: z.object({
      /** Whether a matching voice was found and playback is available. */
      available: z.boolean().optional(),
      spoke: z.string().optional(),
    }),
  },
} as const;
export type UiToolName = keyof typeof UI_TOOLS;
