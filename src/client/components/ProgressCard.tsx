import { useEffect, useState } from 'react';
import { getProgress, type Progress } from '../lib/api.js';

/**
 * Honest progress, at the top of the Library — the motivation surface, built to the tool's ethos:
 * no points, no streaks, nothing that rewards showing up rather than learning. Three true things:
 *  - what you actually know now, counted by DECAYED level (so it moves down when you let things
 *    slip, not only up — the same honesty as the paths' `known` count);
 *  - what you EARNED this week — positive graded evidence, the kind that moves mastery, so the
 *    number means learning shown, not time spent;
 *  - what's slipping — the decay reframed as an opportunity, one click from the review that locks it
 *    back in, rather than a scold.
 *
 * Renders nothing until there's something real to show — a brand-new empty vault gets no vanity
 * "0 mastered" card, only the first genuine progress.
 */
export function ProgressCard({ visible = true }: { visible?: boolean }) {
  const [p, setP] = useState<Progress | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    getProgress().then((v) => { if (!cancelled) setP(v); }).catch(() => {});
    return () => { cancelled = true; };
  }, [visible]);

  if (!p) return null;
  const known = p.byLevel.mastered + p.byLevel.practicing;
  // Nothing earned, nothing known, nothing slipping → no card. Exposure alone isn't an achievement.
  if (known === 0 && p.earnedThisWeek === 0 && p.slipping === 0) return null;

  return (
    <section className="progress-card" aria-label="Your progress">
      <h2 className="progress-title">Your progress</h2>
      <p className="progress-known">
        <strong>{known}</strong> {known === 1 ? 'page' : 'pages'} you can do right now
        {p.byLevel.mastered > 0 && <span className="progress-sub"> · {p.byLevel.mastered} mastered</span>}
        {p.byLevel.exposed > 0 && <span className="progress-sub"> · {p.byLevel.exposed} seen, not yet proven</span>}
      </p>
      {p.earnedThisWeek > 0 && (
        <p className="progress-earned">
          <strong>{p.earnedThisWeek}</strong> graded {p.earnedThisWeek === 1 ? 'check' : 'checks'} earned this week
        </p>
      )}
      {p.slipping > 0 && (
        // Not a button: the review list (ReviewQueue) sits directly below in the Library, so this
        // is the honest headline, not a second way to the same place.
        <p className="progress-slipping">
          {p.slipping} {p.slipping === 1 ? 'page is' : 'pages are'} slipping — a quick review below locks {p.slipping === 1 ? 'it' : 'them'} back in
        </p>
      )}
    </section>
  );
}
