// Ported (import adaptation — ./handWrittenProse.js) from ~/Dev/personal/the-gap
// apps/web/src/DocsPanel.tsx (READ ONLY there). Logic unchanged.
//
// The syntax-error-streak offer: "hand-written doc cards per pattern (title + 2-4 sentence snippet
// + MDN URL) ... Static render." Pure reference material, no interactivity, no code — never the
// learner's own gap.

import { DOC_CARDS_BY_ARTIFACT } from './handWrittenProse.js';

export interface DocsPanelProps {
  artifactId: string;
}

export function DocsPanel({ artifactId }: DocsPanelProps) {
  const cards = DOC_CARDS_BY_ARTIFACT[artifactId] ?? [];

  if (cards.length === 0) {
    return <p className="docs-panel-empty">no docs for this pattern yet.</p>;
  }

  return (
    <div className="docs-panel">
      {cards.map((card) => (
        <article key={card.title} className="doc-card">
          <h3 className="doc-card-title">{card.title}</h3>
          <p className="doc-card-snippet">{card.snippet}</p>
          <a className="doc-card-url" href={card.url} target="_blank" rel="noreferrer">
            {card.url}
          </a>
        </article>
      ))}
    </div>
  );
}
