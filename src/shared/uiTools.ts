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
} as const;
export type UiToolName = keyof typeof UI_TOOLS;
