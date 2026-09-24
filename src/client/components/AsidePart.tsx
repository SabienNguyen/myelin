// Renders a `data-aside` part (src/shared/aside.ts): the answer to a learner's "ask aside"
// question, anchored to the tutor message it was asked about. Collapsed by default — same
// pattern as .reasoning-part — because an aside is a side note, not the point of the message.
import { RichMarkdown } from './RichMarkdown.js';
import { MarkdownLink } from './MarkdownText.js';
import { panelBus, wikiPreprocess } from '../lib/panelBus.js';
import type { AsideData } from '../../shared/aside.js';

const MAX_TOPIC_WORDS = 6;

/** The `<summary>` label: the quoted passage if there was one (it is the more specific anchor),
 * otherwise the first few words of the question — either way short enough to sit on one line. */
function topicFor(quote: unknown, question: unknown): string {
  const source = typeof quote === 'string' && quote ? quote : typeof question === 'string' ? question : '';
  const words = source.split(/\s+/).filter(Boolean);
  const truncated = words.slice(0, MAX_TOPIC_WORDS).join(' ');
  return words.length > MAX_TOPIC_WORDS ? `${truncated}…` : truncated;
}

// The part comes off a thread file on disk, and saveThread stores unvalidated client JSON: one
// hand-edited or corrupted aside ({ answer } alone) threw on render and, with the hash reopening
// the thread, blanked the app on every load. Only the answer is required; the rest degrades.
export function AsidePart({ data }: { data: unknown }) {
  const aside = data as Partial<Record<keyof AsideData, unknown>> | null;
  if (aside == null || typeof aside.answer !== 'string') return null;
  const sources = (Array.isArray(aside.sources) ? aside.sources : [])
    .filter((s): s is AsideData['sources'][number] => typeof s?.url === 'string');
  const vaultPages = (Array.isArray(aside.vaultPages) ? aside.vaultPages : [])
    .filter((slug): slug is string => typeof slug === 'string');
  return (
    <details className="aside-part">
      <summary>aside · {topicFor(aside.quote, aside.question)}</summary>
      <div className="aside-part-body">
        <RichMarkdown text={wikiPreprocess(aside.answer)} />
        {(sources.length > 0 || vaultPages.length > 0) && (
          <ul className="aside-part-sources">
            {sources.map((s) => (
              <li key={s.url}>
                <MarkdownLink href={s.url}>{typeof s.title === 'string' ? s.title : s.url}</MarkdownLink>
              </li>
            ))}
            {vaultPages.map((slug) => (
              <li key={slug}>
                <button type="button" className="wiki-link-btn" onClick={() => panelBus.openPage(slug)}>
                  {slug}
                </button>
              </li>
            ))}
          </ul>
        )}
        {aside.fromMemory === true && <p className="aside-part-memory">from memory — not checked</p>}
      </div>
    </details>
  );
}
