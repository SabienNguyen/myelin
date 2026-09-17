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
