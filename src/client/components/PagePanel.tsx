import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getPage } from '../lib/api.js';
import { WikiLink } from './MarkdownText.js';
import { panelBus, wikiPreprocess } from '../lib/panelBus.js';
import { DECAY } from '../../shared/loreweaver.js';

// The panel used to render `meta.title` + `body` and throw the rest of the payload away. For a
// system whose whole thesis is a JUSTIFIED TYPED GRAPH — every edge carries a rationale someone had
// to write — the page view showed none of the graph, so the one place a learner naturally lands
// after clicking a wiki-link was the one place the structure was invisible. Everything below comes
// out of the payload `/api/page/:slug` already returned, plus neighbour titles and mastery that
// restRoutes.ts now resolves; no new concepts, no new authoring burden, and it works identically for
// chemistry or music theory because none of it knows what the subject is.

type Dir = 'out' | 'in';
type LinkType = 'prereq' | 'deepens' | 'related';

// Direction matters and is easy to get backwards: buildEdges (loreweaver src/graph/graph.ts) writes
// `prereqs: [x]` on page A as A -prereq-> x, i.e. an OUT prereq edge means "A requires x". Labelling
// both directions the same way would invert the teaching order for half the list.
const GROUPS: { dir: Dir; type: LinkType; heading: string; blurb: string }[] = [
  { dir: 'out', type: 'prereq', heading: 'Learn these first', blurb: 'this page assumes them' },
  { dir: 'in', type: 'prereq', heading: 'This unlocks', blurb: 'they assume this page' },
  { dir: 'out', type: 'deepens', heading: 'Goes deeper into', blurb: 'the broader idea underneath' },
  { dir: 'in', type: 'deepens', heading: 'Deeper treatments', blurb: 'pages that refine this one' },
  { dir: 'out', type: 'related', heading: 'Mentions', blurb: '' },
  { dir: 'in', type: 'related', heading: 'Mentioned by', blurb: '' },
];

/**
 * How this page's level was earned, in one sentence.
 *
 * The panel has always been able to show a LEVEL and never how it was reached, so the question a
 * level provokes — "why is this only practising?" — had no answer anywhere in the app. Since
 * grading.ts's capApplied the two passing kinds mean different things: 'applied-correctly' is a
 * machine confirming it, 'explained-correctly' is a model judging it. That distinction is the
 * answer, so this is where it gets said.
 *
 * Deliberately not scolding. "You have explained this but never applied it" is a fact about the
 * evidence, not a verdict on the learner — and in a subject with no applied exercise available it is
 * not even something they could act on, which is why the copy says what is missing rather than what
 * they should have done.
 */
function standingLine(st: { applied: number; explained: number; rubric?: number; struggled: number }): string {
  const rubric = st.rubric ?? 0;
  if (st.applied > 0) {
    const also = [
      st.explained > 0 ? `${st.explained} explanation${st.explained === 1 ? '' : 's'}` : null,
      rubric > 0 ? `${rubric} rubric pass${rubric === 1 ? '' : 'es'}` : null,
    ].filter(Boolean).join(' and ');
    return `Earned by ${st.applied} verified exercise${st.applied === 1 ? '' : 's'}`
      + (also ? ` and ${also}.` : ' — checked mechanically, not judged.');
  }
  if (rubric > 0) {
    // Its own sentence, not folded into "explanations": a rubric pass is judged WORK, it holds the
    // page up on a shorter decay window, and the learner deserves to know which kind is doing the
    // holding.
    return `Held up by ${rubric} rubric pass${rubric === 1 ? '' : 'es'}${st.explained > 0 ? ` and ${st.explained} explanation${st.explained === 1 ? '' : 's'}` : ''} — `
      + 'work judged against stated criteria, re-checked sooner than machine-verified work.';
  }
  if (st.explained > 0) {
    return `Earned by ${st.explained} explanation${st.explained === 1 ? '' : 's'}, judged by the tutor. `
      + 'No exercise has confirmed it.';
  }
  if (st.struggled > 0) return 'You have attempted this and not landed it yet.';
  return 'Seen, but nothing recorded yet.';
}

/** Days until this level decays, using the same windows the graph's rings use. */
function daysUntilDecay(effective: string, lastReinforced: string, restsOnRubric = false, now = new Date()): number | null {
  const window = effective === 'mastered' ? DECAY.masteredDays
    : effective === 'practicing' ? (restsOnRubric ? DECAY.rubricDays : DECAY.practicingDays) : null;
  if (window == null) return null;
  const elapsed = Math.floor((now.getTime() - new Date(lastReinforced).getTime()) / 86_400_000);
  return Math.max(0, window - elapsed);
}

const MASTERY_LABEL: Record<string, string> = {
  unseen: 'not started',
  exposed: 'seen once',
  practicing: 'practising',
  mastered: 'mastered',
};

function MasteryDot({ level }: { level: string | null }) {
  const key = level ?? 'unseen';
  const label = MASTERY_LABEL[key] ?? key;
  // The dot is a colour, and colour is never the only channel — the label carries the same fact to a
  // screen reader and to anyone who cannot separate the four hues.
  return <span className={`page-mastery-dot mastery-${key}`} role="img" aria-label={label} title={label} />;
}

function EdgeList({
  edges, neighbors, group,
}: {
  edges: any[];
  neighbors: Record<string, { title: string | null; mastery: string | null }>;
  group: { dir: Dir; heading: string; blurb: string };
}) {
  return (
    <section className="page-edge-group">
      <h4>
        {group.heading}
        {group.blurb && <span className="page-edge-blurb"> — {group.blurb}</span>}
      </h4>
      <ul>
        {edges.map((e, i) => {
          const slug = group.dir === 'out' ? e.dst : e.src;
          const info = neighbors[slug];
          const missing = info !== undefined && info.title === null;
          return (
            <li key={`${slug}-${i}`}>
              <span className="page-edge-head">
                <MasteryDot level={info?.mastery ?? null} />
                {missing
                  // A declared prereq with no page behind it. Loreweaver models this case
                  // (`missingTargets`), and naming it beats a link that silently lands on
                  // "Could not load" — the vault genuinely has a hole here.
                  ? <span className="page-edge-missing">{slug} <em>— no page yet</em></span>
                  : (
                    <button type="button" className="page-edge-link" onClick={() => panelBus.openPage(slug)}>
                      {info?.title ?? slug}
                    </button>
                  )}
              </span>
              {/* The rationale is why this edge exists — the thing that makes the graph a taught
                  structure rather than a pile of associations. It is the point of showing edges at
                  all, so it is shown, not folded behind a disclosure. */}
              {e.rationale && <p className="page-edge-rationale">{e.rationale}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function PagePanel({ slug }: { slug: string | null }) {
  const [page, setPage] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  // The un-caught version left the panel on "Loading…" forever whenever the fetch rejected (backend
  // down, proxy 502, non-JSON body) — indistinguishable from a slow load. Reset both on slug change
  // so switching pages after a failure retries instead of showing the stale error.
  useEffect(() => {
    if (!slug) return;
    setPage(null);
    setError(null);
    getPage(slug)
      .then(setPage)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [slug]);
  if (!slug) return <p className="empty">Click a wiki-link or graph node.</p>;
  // getPage names the slug in the message itself, so no prefix here — see PathsSection.
  if (error) return <p className="panel-error" role="status">{error}</p>;
  if (!page) return <p className="empty">Loading…</p>;

  const meta = page.page.meta ?? {};
  const edges = page.edges ?? {};
  const neighbors = page.neighbors ?? {};
  const warnings: string[] = page.page.warnings ?? [];
  const standing = page.standing ?? null;
  const decayIn = standing ? daysUntilDecay(standing.effective, standing.lastReinforced, (standing as any).restsOnRubric) : null;
  const groups = GROUPS
    .map((g) => ({ g, edges: (edges[g.dir] ?? []).filter((e: any) => e.type === g.type) }))
    .filter(({ edges: es }) => es.length > 0);

  return (
    <article className="page-panel">
      <h2>{meta.title ?? page.page.slug}</h2>

      <div className="page-meta">
        {meta.status && <span className={`page-chip page-status-${meta.status}`}>{meta.status}</span>}
        {typeof meta.difficulty === 'number' && (
          <span className="page-chip">difficulty {meta.difficulty}/5</span>
        )}
        {page.page.domain && <span className="page-chip">{page.page.domain}</span>}
        {(meta.tags ?? []).map((t: string) => <span key={t} className="page-chip page-tag">#{t}</span>)}
      </div>

      {standing && (
        <section className="page-standing">
          <h3>Your standing</h3>
          <p className="page-standing-level">
            <MasteryDot level={standing.effective} />
            <span>{MASTERY_LABEL[standing.effective] ?? standing.effective}</span>
            {/* Only shown when the stored level and the decay-adjusted one disagree: that gap is
                the single most confusing thing the mastery model does, and it is invisible today. */}
            {standing.effective !== standing.level && (
              <em className="page-standing-decayed">
                — was {MASTERY_LABEL[standing.level] ?? standing.level}, decayed since {standing.lastReinforced}
              </em>
            )}
          </p>
          <p className="page-standing-why">{standingLine(standing)}</p>
          {decayIn != null && (
            <p className="page-standing-decay">
              {decayIn === 0
                ? 'Due for review now.'
                : `Holds for ${decayIn} more day${decayIn === 1 ? '' : 's'} without practice.`}
            </p>
          )}
          {standing.misconceptions.length > 0 && (
            <ul className="page-standing-misconceptions">
              {standing.misconceptions.map((m: string, i: number) => <li key={i}>{m}</li>)}
            </ul>
          )}
        </section>
      )}

      {/* Vault-authored warnings (e.g. a body that outgrew its `stub` status). Previously visible
          only to someone reading the markdown by hand. */}
      {warnings.length > 0 && (
        <ul className="page-warnings" role="status">
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}

      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: WikiLink }}>
        {wikiPreprocess(page.page.body)}
      </ReactMarkdown>

      {groups.length > 0 && (
        <div className="page-edges">
          <h3>Connections</h3>
          {groups.map(({ g, edges: es }) => (
            <EdgeList key={`${g.dir}-${g.type}`} edges={es} neighbors={neighbors} group={g} />
          ))}
        </div>
      )}

      {(meta.sources ?? []).length > 0 && (
        <div className="page-sources">
          <h3>Sources</h3>
          <ul>{meta.sources.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
        </div>
      )}
    </article>
  );
}
