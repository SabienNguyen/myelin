// I3 (docs/superpowers/plans/2026-07-20-gap-integration.md): "one place to learn" — Practice
// entry lives in the Library tab, but clicking a row never talks to the gap or writes evidence
// itself. It just hands the composer a message; the tutor stays the orchestrator (decides the
// rung, calls code_exercise, grades, records evidence) exactly as it would if the student typed
// the same request by hand.

import { useEffect, useState } from 'react';
import { useThreadRuntime } from '@assistant-ui/react';
import { CodeIcon as Code } from '@phosphor-icons/react';

type Ownership = 'owned' | 'rented' | 'new';

interface Row {
  pattern: string;
  ownership: Ownership;
}

const OWNERSHIP_LABEL: Record<Ownership, string> = {
  owned: 'owned', rented: 'rented', new: 'new',
};

// Mapping from the plan (I3 item 2): a pattern's vault mastery, read via GET /api/student, decides
// the badge shown next to it. "Owned" means real applied evidence has accumulated (effective
// mastery has reached practicing or mastered); "rented" means the student has only been exposed
// (watched/read it, no graded evidence yet); "new" means there's no mastery record for the pattern
// slug at all — never practiced.
function ownershipFor(effective: string | undefined): Ownership {
  if (effective === 'practicing' || effective === 'mastered') return 'owned';
  if (effective === 'exposed') return 'rented';
  return 'new';
}

export function PracticePanel({ visible = true }: { visible?: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const threadRuntime = useThreadRuntime();

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      // GET /api/gap/ladder 404s when cfg.gap is absent (see gapProxy.ts) — treat that the same
      // as "no ladders", not an error worth surfacing in the Library tab.
      const ladderRes = await fetch('/api/gap/ladder').catch(() => null);
      if (!ladderRes?.ok) { if (!cancelled) setRows([]); return; }
      const { ladder } = await ladderRes.json();
      const pattern: string | undefined = ladder?.pattern;
      if (!pattern) { if (!cancelled) setRows([]); return; }

      const studentRes = await fetch('/api/student').catch(() => null);
      const student = studentRes?.ok ? await studentRes.json() : {};
      if (cancelled) return;
      setRows([{ pattern, ownership: ownershipFor(student?.[pattern]?.effective) }]);
    })();
    return () => { cancelled = true; };
  }, [visible]);

  if (!rows || rows.length === 0) return null;

  return (
    <section className="practice-panel">
      <h3>Practice</h3>
      <ul>
        {rows.map((row) => (
          <li key={row.pattern}>
            <button
              type="button"
              className="practice-row"
              onClick={() => threadRuntime.append(`Practice ${row.pattern} with a code exercise`)}
            >
              <Code size={14} weight="duotone" />
              <span className="practice-pattern">{row.pattern}</span>
              <span className={`practice-tag practice-tag--${row.ownership}`}>
                {OWNERSHIP_LABEL[row.ownership]}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
