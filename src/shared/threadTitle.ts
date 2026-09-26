// A conversation's title, derived from its messages rather than stored: the history list (server)
// and the conversation's own header (client) must name it the same way.

const TITLE_MAX = 60;

/** Best-effort title: the first SUBSTANTIVE user text (≥ 12 chars) — "hi" openers make
 * indistinguishable rows in the picker, so prefer the message that says what the conversation
 * is about. Falls back to the first user text of any length, then the thread id. */
export function titleFor(messages: unknown[], id: string): string {
  const userTexts = (messages as any[])
    .filter((m) => m && m.role === 'user')
    .map((m) => m.parts?.find((p: any) => p?.type === 'text' && typeof p.text === 'string')?.text?.trim())
    .filter((t): t is string => !!t);
  const trimmed = userTexts.find((t) => t.length >= 12) ?? userTexts[0];
  if (!trimmed) return id;
  // The first sentence when it is a real one: an opening like "Quiz me across Calculus I. One
  // question per page: …" titles as its first sentence rather than 60 characters cut mid-list.
  const sentence = firstSentence(trimmed);
  const title = sentence.length >= 12 ? sentence : trimmed;
  // Code points, not UTF-16 units: slicing an emoji at the limit left half a surrogate pair.
  const chars = Array.from(title);
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : title;
}

// "Explain limits, e.g. what is x approaching…" titled as "Explain limits, e.g." — a Latin full
// stop ends a sentence only before a capital, and never after these abbreviations.
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|cf|approx|incl|mr|mrs|ms|dr|st|no|fig)\.$/i;

function firstSentence(text: string): string {
  for (const m of text.matchAll(/[.?!](?=\s+(\S))|[。？！]/g)) {
    const head = text.slice(0, m.index + 1);
    if (m[1] === undefined) return head;
    if (!/\p{Lu}/u.test(m[1]) || ABBREVIATION.test(head)) continue;
    return head;
  }
  return text;
}
