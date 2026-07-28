// Curated paths as the learner's syllabus — the first learner-facing surface they have ever had.
//
// Loreweaver has shipped create_path / list_paths / read_path from the start, and the harness exposed
// none of it: the tutor could read a path, the learner could not see one. So a subject had no visible
// spine and no answer to "how far through this am I", which is the question someone learning a new
// subject actually has. Progress is decay-aware (it counts EFFECTIVE practicing/mastered), so a path
// stops claiming credit for something the learner has since lost.

import { useEffect, useState } from 'react';
import { panelBus } from '../lib/panelBus.js';
import { getPaths, setGoal, type PathsPayload, type PathRow } from '../lib/api.js';

function PathRowView({ row, isGoal, onSetGoal }: {
  row: PathRow; isGoal: boolean; onSetGoal: (slug: string | null) => void;
}) {
  const pct = row.total === 0 ? 0 : Math.round((row.known / row.total) * 100);
  const complete = row.total > 0 && row.known === row.total;
  return (
    <li className={`path-row${isGoal ? ' path-row--goal' : ''}`}>
      <div className="path-row-head">
        <span className="path-title">{row.title}</span>
        {isGoal && <span className="path-goal-tag">goal</span>}
        <span className="path-count">{row.known}/{row.total}</span>
      </div>
      {/* aria-hidden: the count above is the accessible version of the same information, so the bar
          is decoration rather than a second thing a screen reader has to parse. */}
      <div className="path-meter" aria-hidden="true">
        <span className="path-meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="path-row-actions">
        {complete
          ? <span className="path-next">complete</span>
          : row.nextSlug
            ? (
              <button
                type="button"
                className="ghost-btn path-resume"
                onClick={() => panelBus.openPage(row.nextSlug!)}
              >
                {/* Title, not slug: "resume at Forward pass", falling back to the slug only when
                    the server couldn't resolve the page (it may not be written yet). */}
                resume at {row.nextTitle ?? row.nextSlug}
              </button>
            )
            : <span className="path-next">no pages yet</span>}
        <button
          type="button"
          className="ghost-btn"
          onClick={() => onSetGoal(isGoal ? null : row.slug)}
        >
          {isGoal ? 'clear goal' : 'set as goal'}
        </button>
      </div>
    </li>
  );
}

export function PathsSection({ visible = true }: { visible?: boolean }) {
  const [data, setData] = useState<PathsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    getPaths().then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }
  // Only fetch while the panel is actually on screen — the Library is a hidden tab most of the time.
  useEffect(() => { if (visible) load(); }, [visible]);

  async function changeGoal(slug: string | null) {
    try {
      await setGoal(slug === null ? null : { kind: 'path', slug });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // No "Could not load paths —" prefix: lib/api.ts already names the subject, and wrapping it
  // produced "Could not load paths — Couldn’t load your learning paths — ...". `.panel-error`
  // rather than `.empty` because an empty state and a failure are not the same news.
  if (error) return <p className="panel-error" role="status">{error}</p>;
  if (!data) return null;

  // Do NOT trust the payload's shape. A partial or unexpected response (a proxy error page, an older
  // server, a mocked fetch in a test) previously threw on `data.paths.length` and took the entire
  // Library panel down with a React error — and it surfaced only as an "unhandled error" while the
  // suite still reported green. Same class as PagePanel's missing .catch: degrade, never crash.
  const paths = Array.isArray(data.paths) ? data.paths : [];
  const goal = data.goal ?? null;

  return (
    <section className="paths-section">
      <h2>Paths</h2>
      {paths.length === 0
        ? (
          <p className="empty">
            No paths yet — ask the tutor (freeform) to build one for what you want to learn, and it
            becomes your syllabus.
          </p>
        )
        : (
          <ul className="paths-list">
            {paths.map((row) => (
              <PathRowView
                key={row.slug}
                row={row}
                isGoal={goal?.kind === 'path' && goal.slug === row.slug}
                onSetGoal={changeGoal}
              />
            ))}
          </ul>
        )}
    </section>
  );
}
