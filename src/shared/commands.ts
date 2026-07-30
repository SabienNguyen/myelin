// The slash-command vocabulary — one list, two consumers: the composer's suggestion menu offers
// exactly these, and chatRoute validates the POSTed `command` against them (unknown → 400). The
// wire carries a structured `{ command, text }`, never the raw "/beginner …" prose, so the model
// transcript stays clean and the server never parses slash syntax.

/** Stance commands: HOW the tutor researches and teaches, persisted per thread (stanceStore.ts)
 * until the next stance command replaces it. */
export const STANCE_COMMANDS = ['beginner', 'intermediate', 'advanced'] as const;
export type Stance = (typeof STANCE_COMMANDS)[number];

/** Mode commands: one-shot routes onto the existing tutor modes. The names mirror prompt.ts's
 * MODES verbatim (shared code cannot import server code; chatRoute.test.ts pins the overlap) —
 * the server overrides the turn's mode, the client persists the topbar selector. */
export const MODE_COMMANDS = ['learn', 'review', 'quiz', 'freeform'] as const;

/** Every command the wire accepts. `write` rides the existing one-shot writeUp promotion. */
export const COMMANDS = [...STANCE_COMMANDS, ...MODE_COMMANDS, 'write'] as const;
export type Command = (typeof COMMANDS)[number];

export function isCommand(value: unknown): value is Command {
  return typeof value === 'string' && (COMMANDS as readonly string[]).includes(value);
}

export function isStance(value: unknown): value is Stance {
  return typeof value === 'string' && (STANCE_COMMANDS as readonly string[]).includes(value);
}
