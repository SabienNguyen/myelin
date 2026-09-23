// Renders a `data-aside` part (src/shared/aside.ts): the answer to a learner's "ask aside"
// question, anchored to the tutor message it was asked about. Collapsed by default — same
// pattern as .reasoning-part — because an aside is a side note, not the point of the message.
import { RichMarkdown } from './RichMarkdown.js';
import { panelBus } from '../lib/panelBus.js';
import type { AsideData } from '../../shared/aside.js';

const MAX_TOPIC_WORDS = 6;

/** The `<summary>` label: the quoted passage if there was one (it is the more specific anchor),
 * otherwise the first few words of the question — either way short enough to sit on one line. */
function topicFor({ quote, question }: AsideData): string {
  const source = quote ?? question;
  const words = source.split(/\s+/).filter(Boolean);
  const truncated = words.slice(0, MAX_TOPIC_WORDS).join(' ');
  return words.length > MAX_TOPIC_WORDS ? `${truncated}…` : truncated;
}

export function AsidePart({ data }: { data: unknown }) {
  const aside = data as AsideData | null;
  if (aside == null || typeof aside.answer !== 'string') return null;
  return (
    <details className="aside-part">
      <summary>aside · {topicFor(aside)}</summary>
      <div className="aside-part-body">
        <RichMarkdown text={aside.answer} />
        {(aside.sources.length > 0 || aside.vaultPages.length > 0) && (
          <ul className="aside-part-sources">
            {aside.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title ?? s.url}</a>
              </li>
            ))}
            {aside.vaultPages.map((slug) => (
              <li key={slug}>
                <button type="button" className="wiki-link-btn" onClick={() => panelBus.openPage(slug)}>
                  {slug}
                </button>
              </li>
            ))}
          </ul>
        )}
        {aside.fromMemory && <p className="aside-part-memory">from memory — not checked</p>}
      </div>
    </details>
  );
}
