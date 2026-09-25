// The pages a conversation is about when it never opened or wrote one. A thread that only
// web-searched "focus" and "flow state" left This topic empty beside two flow pages in the vault.
// A page matches on the words its title shares with what the learner typed, each weighted by how
// few titles carry it: "learning" (in three titles) counts for less than "flow" (two) or "focus"
// (one), so a common word alone does not pull in an unrelated subject.
import type { UIMessage } from '../../shared/uiMessages.js';

const STOP = new Set([
  'the', 'and', 'for', 'with', 'about', 'what', 'how', 'why', 'when', 'where', 'which', 'who',
  'can', 'could', 'should', 'would', 'does', 'did', 'are', 'was', 'were', 'this', 'that', 'these',
  'those', 'tell', 'explain', 'into', 'from', 'but', 'not', 'you', 'your', 'our', 'its', 'their',
  'there', 'here', 'put', 'together', 'more', 'some', 'any', 'all', 'one', 'two', 'get', 'use',
  'hey', 'hello', 'thanks', 'please', 'good', 'bad', 'yes', 'lets', 'let', 'also',
]);

// A match must score at least this share of the best one: the best page's subject, not every page
// that shares a single common word with it.
const MATCH_SHARE = 0.5;
const MAX_MATCHED = 5;

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** Everything the learner typed in `messages`, one line per message. */
export function learnerText(messages: UIMessage[]): string {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' '))
    .join('\n');
}

/** Slugs of the pages in `pages` whose titles best match `asked`, best first, at most MAX_MATCHED;
 *  empty when no title shares a word with it. Pure. */
export function matchPages(asked: string, pages: { slug: string; title: string }[]): string[] {
  const askedWords = words(asked);
  if (askedWords.size === 0) return [];
  const titles = pages.map((p) => words(p.title));
  const df = new Map<string, number>();
  for (const t of titles) for (const w of t) df.set(w, (df.get(w) ?? 0) + 1);
  const scored = pages.map((p, i) => {
    let score = 0;
    for (const w of titles[i]) if (askedWords.has(w)) score += Math.log((pages.length + 1) / df.get(w)!);
    return { slug: p.slug, score };
  });
  const best = Math.max(0, ...scored.map((s) => s.score));
  if (best === 0) return [];
  return scored
    .filter((s) => s.score >= best * MATCH_SHARE)
    .sort((a, b) => b.score - a.score || (a.slug < b.slug ? -1 : 1))
    .slice(0, MAX_MATCHED)
    .map((s) => s.slug);
}
