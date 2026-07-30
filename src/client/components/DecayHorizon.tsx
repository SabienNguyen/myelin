// The decay landscape as a single rail — "now" on the left, 45 days (the longest decay window)
// on the right, every page with a clock as a tick at its daysLeft. ProgressCard counts what is
// slipping and ReviewQueue lists the urgent slice; neither shows SHAPE — whether your knowledge
// is bunched at the cliff edge or spread safely out — and that is the one thing a glance at
// positions gives that numbers cannot. Reads /api/horizon, whose sort (slipped first, then
// tightest countdown) is kept as DOM order so keyboard traversal goes most-urgent-first.

import { useEffect, useState, type CSSProperties } from 'react';
import { panelBus } from '../lib/panelBus.js';

interface HorizonPage {
  slug: string;
  title: string;
  level: string;
  daysLeft: number | null;
  slipped: boolean;
}

// engram's DECAY.masteredDays — the widest window anything can hold for, so the axis's right edge.
const WINDOW_DAYS = 45;

export function DecayHorizon({ visible = true }: { visible?: boolean }) {
  const [pages, setPages] = useState<HorizonPage[]>([]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    fetch('/api/horizon')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setPages(d.pages ?? []); })
      .catch(() => { /* no horizon is a quiet state — the Library stands without it */ });
    return () => { cancelled = true; };
  }, [visible]);

  // Only pages actually on the axis: a countdown, or already past it. An unslipped page with a
  // null daysLeft has no clock at all (exposed — nothing to lose), so no position here.
  const ticks = pages.filter((p) => p.slipped || p.daysLeft !== null);
  // One tick is not a landscape — ProgressCard's countdown line already covers it. No empty state.
  if (ticks.length < 2) return null;

  return (
    <section className="decay-horizon" aria-label="Decay horizon">
      <div className="horizon-rail">
        {ticks.map((p) => {
          const label = p.slipped
            ? `${p.title} — due now`
            : `${p.title} — slips in ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}`;
          // Slipped pages sit AT the now line — they are past it, not on the axis. The clamp is
          // for a daysLeft beyond the window (a fresher decay rule server-side must not push a
          // tick out of the rail), not for negatives: slipped is the only under-zero state.
          const left = p.slipped ? 0 : Math.min(100, Math.max(0, ((p.daysLeft ?? 0) / WINDOW_DAYS) * 100));
          return (
            <button
              key={p.slug}
              type="button"
              className={`horizon-tick${p.slipped ? ' horizon-tick--slipped' : ''}`}
              style={{ left: `${left}%`, '--tick': `var(--mastery-${p.level}, var(--mastery-unseen))` } as CSSProperties}
              aria-label={label}
              title={label}
              onClick={() => panelBus.openPage(p.slug)}
            />
          );
        })}
      </div>
      <div className="horizon-axis" aria-hidden="true">
        <span>now</span>
        <span>{WINDOW_DAYS}d</span>
      </div>
    </section>
  );
}
