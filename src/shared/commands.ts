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
export const MODE_COMMANDS = ['chat', 'learn', 'review', 'quiz', 'freeform'] as const;

/** `/study [topic]`: the one command that does NOT name a mode of its own — it routes onto the
 * existing `learn` tutor (see commandMode below), sticky until the learner sends `/chat` or ends
 * the session client-side. Kept separate from MODE_COMMANDS so that list can keep mirroring
 * prompt.ts's MODES exactly. */
export const STUDY_COMMAND = 'study' as const;

/** Every command the wire accepts. `write` rides the existing one-shot writeUp promotion. */
export const COMMANDS = [...STANCE_COMMANDS, ...MODE_COMMANDS, STUDY_COMMAND, 'write'] as const;
export type Command = (typeof COMMANDS)[number];

export function isCommand(value: unknown): value is Command {
  return typeof value === 'string' && (COMMANDS as readonly string[]).includes(value);
}

export function isStance(value: unknown): value is Stance {
  return typeof value === 'string' && (STANCE_COMMANDS as readonly string[]).includes(value);
}

/** Which mode, if any, a command puts the turn in. `study` maps onto `learn` — the tutor rather
 * than a mode of its own — every MODE_COMMAND maps onto itself, and a stance command or `write`
 * sets no mode (write rides the existing writeUp promotion instead). */
export function commandMode(command: Command): (typeof MODE_COMMANDS)[number] | undefined {
  if (command === STUDY_COMMAND) return 'learn';
  return (MODE_COMMANDS as readonly string[]).includes(command)
    ? (command as (typeof MODE_COMMANDS)[number])
    : undefined;
}
