// The pages a conversation worked on, read from its tool parts. Shared because the server derives
// a notebook's topics and the tutor's current topic from it, and the client's Stage lists the same
// pages for the open conversation — one reading of "which pages", not two that drift.
import { isToolUIPart, getToolName, type UIMessage } from './uiMessages.js';

/** Tool names whose `slug` input names the page a turn was actually working on — as opposed to
 *  e.g. `search`, whose input is a query, not a page. */
const TOPIC_TOOLS = new Set(['record_evidence', 'write_page', 'read_page']);

/** The page this thread is currently about: the slug of the most recent record_evidence,
 *  write_page or read_page tool part (by message order, last part wins) in the UI history, or
 *  null. Pure. Lets vaultGap check the page a continuation turn ("ok", "lets go!") is actually
 *  continuing, instead of giving up because the turn itself names no topic. */
export function threadTopic(messages: UIMessage[]): string | null {
  return topicSlugs(messages).at(-1) ?? null;
}

/** Every page this thread worked on, first-seen order, no repeats — a notebook's topics are the
 *  union of these across its conversations (notebookStore.ts's notebookTopics). Pure. */
export function pagesTouched(messages: UIMessage[]): string[] {
  return [...new Set(topicSlugs(messages))];
}

// Runs on thread files read back from disk (notebook topics), not only on a request's validated
// messages — and saveThread stores unvalidated client JSON, so a null message or a part with no
// type is possible there. One bad file must not take down every notebook view or chat turn that
// reads it, so anything that is not message-shaped is skipped.
function topicSlugs(messages: UIMessage[]): string[] {
  const slugs: string[] = [];
  for (const m of messages as unknown[]) {
    const parts = (m as { parts?: unknown } | null)?.parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (typeof p?.type !== 'string' || !isToolUIPart(p) || !TOPIC_TOOLS.has(getToolName(p))) continue;
      // A failed call worked on nothing: a made-up read_page slug listed as "not started" beside
      // the real pages. Errors arrive as the loop's output-error or as MCP's {isError} output.
      if (p.state === 'output-error' || (p.output as { isError?: unknown } | undefined)?.isError) continue;
      const slug = (p.input as { slug?: unknown } | undefined)?.slug;
      if (typeof slug === 'string') slugs.push(slug);
    }
  }
  return slugs;
}
