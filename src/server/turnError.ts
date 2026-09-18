/** The abort reason the idle watchdog uses.
 *
 * Stop, a superseding send and a stalled provider all reach the turn as the same abort, and the
 * first two are not failures — nobody needs to be told they pressed Stop. A stall IS one: the
 * provider went quiet mid-turn and the watchdog ended it, which without a word looks exactly like
 * the app dying. Naming the reason is what lets the stream tell them apart. */
export class TurnStalled extends Error {
  constructor(ms: number) {
    const minutes = Math.round(ms / 60_000);
    super(`The tutor stopped responding — nothing arrived for ${minutes} minutes, so this turn was `
      + 'ended rather than left hanging. Nothing you did was lost: send your message again, and if '
      + 'it keeps stalling, try a different model from the model badge in the top bar.');
    this.name = 'TurnStalled';
  }
}

/** The note a stalled turn closes on, or undefined for an abort that needs no explanation.
 *  Passed to createUiStream as `abortText`. */
export function stalledText(reason: unknown): string | undefined {
  return reason instanceof TurnStalled ? reason.message : undefined;
}

/** What the learner is told when a turn dies. One phrasing for the agentic loop and rails. */
export function explainTurnError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);

  // "Request too large … tokens per minute (TPM): Limit 8000, Requested 11417" — Groq's wording,
  // and the shape of any per-minute cap smaller than one request. It is NOT an ordinary rate
  // limit: nothing was used up, the single request is bigger than a whole minute's allowance, so
  // it fails identically forever. The raw text gives the learner two numbers and no way forward
  // (and their provider account id); the agentic tutor's fixed cost — system prompt plus tool
  // schemas, ~11k tokens before a word of conversation — is why, and rails is the way out.
  const tooLarge = /request too large/i.test(msg)
    && /limit\s+(\d+)[\s\S]*?requested\s+(\d+)/i.exec(msg);
  if (tooLarge) {
    const [limit, requested] = [Number(tooLarge[1]), Number(tooLarge[2])].map((n) => n.toLocaleString('en-US'));
    return `This turn needs about ${requested} tokens, but your model provider allows ${limit} per minute for this `
      + 'model — one tutor request is larger than the whole allowance, so retrying will not help. Turn on rails for '
      + 'the tutor (model badge, top bar), which sends much smaller requests, or pick a model or provider tier with a '
      + 'higher per-minute limit.';
  }
  return `The tutor hit an error and this turn was lost: ${msg.slice(0, 200)}`;
}
