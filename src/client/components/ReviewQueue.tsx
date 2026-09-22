// The review queue — the spacing loop's visible half. Decay windows always ran (engram's
// effectiveLevel), but nothing surfaced "this is about to slip" anywhere a learner would see it
// without going looking. Optimal review timing is the SYSTEM's job; this section is where it
// does that job.
//
// Same delegation shape as PracticePanel: clicking a row never grades or writes anything — it
// hands the composer a message and the tutor stays the orchestrator (picks the block, grades,
// records evidence).

import { useEffect, useState } from 'react';
import { Collapsible } from './Collapsible.js';
import { useThreadRuntime } from '@assistant-ui/react';
import { ClockCountdownIcon as Hourglass } from '@phosphor-icons/react';
import { getDue, type DueRow } from '../lib/api.js';

const Section = ({ children }: { children: React.ReactNode }) => (
  <Collapsible id="review" level={3} label="Review" className="review-queue" title={<><Hourglass size={16} weight="duotone" /> Review</>}>
    {children}
  </Collapsible>
);

export function ReviewQueue({ visible = true }: { visible?: boolean }) {
  const [due, setDue] = useState<DueRow[] | null>(null);
  const [total, setTotal] = useState(0);
  // Three states, not two. A swallowed fetch rendered the same nothing an empty queue does, so a
  // learner whose pages were decaying read the silence as "all clear".
  const [failed, setFailed] = useState<string | null>(null);
  const threadRuntime = useThreadRuntime();

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    getDue()
      .then((d) => {
        if (cancelled) return;
        const rows = Array.isArray(d.due) ? d.due : [];
        setDue(rows);
        setTotal(d.total ?? rows.length);
        setFailed(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailed(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [visible]);

  // The heading stays, so the section's absence never means "you are done". No prefix on the
  // message — lib/api.ts already names the subject (PathsSection makes the same argument).
  if (failed !== null) {
    return (
      <Section>
        <p className="panel-error" role="status">
          {failed} Nothing is listed because the queue could not be read, not because nothing is due.
        </p>
      </Section>
    );
  }
  if (!due || due.length === 0) return null;

  return (
    <Section>
      <p className="review-queue-lede">
        {due.some((d) => d.slipped)
          ? 'Some of what you earned has started to slip — a quick rep brings it back.'
          : 'These are close to slipping — a quick rep now resets the clock.'}
        {/* No silent caps: the list stays humane, the count stays honest. */}
        {total > due.length && ` Showing the ${due.length} most urgent of ${total}.`}
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
    </Section>
  );
}
