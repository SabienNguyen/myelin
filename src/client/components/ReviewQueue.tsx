// The review queue — the spacing loop's visible half. Decay windows always ran (loreweaver's
// effectiveLevel), but nothing surfaced "this is about to slip" anywhere a learner would see it
// without going looking. Optimal review timing is the SYSTEM's job; this section is where it
// does that job.
//
// Same delegation shape as PracticePanel: clicking a row never grades or writes anything — it
// hands the composer a message and the tutor stays the orchestrator (picks the block, grades,
// records evidence).

import { useEffect, useState } from 'react';
import { useThreadRuntime } from '@assistant-ui/react';
import { ClockCountdownIcon as Hourglass } from '@phosphor-icons/react';

interface DueRow {
  slug: string;
  title: string;
  effective: string;
  level: string;
  daysLeft: number | null;
  slipped: boolean;
}

export function ReviewQueue({ visible = true }: { visible?: boolean }) {
  const [due, setDue] = useState<DueRow[] | null>(null);
  const threadRuntime = useThreadRuntime();

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    fetch('/api/due')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setDue(d.due ?? []); })
      .catch(() => { /* no queue is a quiet state, not an error banner — the Library still works */ });
    return () => { cancelled = true; };
  }, [visible]);

  if (!due || due.length === 0) return null;

  return (
    <section className="review-queue">
      <h3><Hourglass size={16} weight="duotone" /> Review</h3>
      <p className="review-queue-lede">
        {due.some((d) => d.slipped)
          ? 'Some of what you earned has started to slip — a quick rep brings it back.'
          : 'These are close to slipping — a quick rep now resets the clock.'}
      </p>
      <ul>
        {due.map((d) => (
          <li key={d.slug}>
            <button
              type="button"
              className="review-row"
              onClick={() => threadRuntime.append(
                `Reinforce "${d.slug}" — quiz me or set an exercise, whichever fits it best.`,
              )}
            >
              <span className="review-title">{d.title}</span>
              <span className={`review-when${d.slipped ? ' review-when--slipped' : ''}`}>
                {d.slipped ? `slipped from ${d.level}` : `${d.daysLeft}d left`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
