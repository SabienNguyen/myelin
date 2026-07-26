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

// B2c: GET /api/gap/ladder's `mined` array (gapProxy.ts's GapMinedEntry) — one row per
// gauntlet-passed artifact mined from a repo. `slug` doubles as the code_exercise pageSlug: it's
// `rung.artifactId`, which is EXACTLY the seeded vault page's slug by construction (both are the
// mined artifact directory's own basename — see ingestRepo.ts's seedMinedArtifactPage).
interface MinedRow {
  slug: string;
  title: string;
  family: string;
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

function minedRowsFrom(payload: any): MinedRow[] {
  const raw = Array.isArray(payload?.mined) ? payload.mined : [];
  return raw
    .map((entry: any): MinedRow => ({
      slug: typeof entry?.rung?.artifactId === 'string' ? entry.rung.artifactId : '',
      title: typeof entry?.meta?.title === 'string' ? entry.meta.title : (entry?.rung?.artifactId ?? 'mined pattern'),
      family: typeof entry?.meta?.family === 'string' ? entry.meta.family : 'mined',
    }))
    .filter((row: MinedRow) => row.slug);
}

export function PracticePanel({ visible = true }: { visible?: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [mined, setMined] = useState<MinedRow[]>([]);
  const threadRuntime = useThreadRuntime();

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      const ladderRes = await fetch('/api/gap/ladder').catch(() => null);
      if (!ladderRes?.ok) { if (!cancelled) { setRows([]); setMined([]); } return; }
      const payload = await ladderRes.json();
      const minedRows = minedRowsFrom(payload);

      // The full pattern list — including approved GENERATED exercises, which the audit found
      // invisible here: Practice showed only the default ladder's pattern while the sandbox was
      // happily serving more. The external sidecar has no /patterns route; its 404 falls back to
      // the one ladder-derived row, the exact old behaviour.
      const patternsRes = await fetch('/api/gap/patterns').catch(() => null);
      const patterns: { pattern: string }[] = patternsRes?.ok
        ? (await patternsRes.json()).patterns ?? []
        : (payload?.ladder?.pattern ? [{ pattern: payload.ladder.pattern }] : []);
      if (patterns.length === 0) { if (!cancelled) { setRows([]); setMined(minedRows); } return; }

      const studentRes = await fetch('/api/student').catch(() => null);
      const student = studentRes?.ok ? await studentRes.json() : {};
      if (cancelled) return;
      setRows(patterns.map(({ pattern }) => ({
        pattern, ownership: ownershipFor(student?.[pattern]?.effective),
      })));
      setMined(minedRows);
    })();
    return () => { cancelled = true; };
  }, [visible]);

  if (rows === null) return null;
  if (rows.length === 0 && mined.length === 0) return null;

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
      {mined.length > 0 && (
        <>
          <h4 className="practice-group-label">From your repos</h4>
          <ul>
            {mined.map((row) => (
              <li key={row.slug}>
                <button
                  type="button"
                  className="practice-row practice-row--mined"
                  onClick={() => threadRuntime.append(
                    `Practice the "${row.title}" pattern (mined artifact, pageSlug "${row.slug}") with a code exercise.`,
                  )}
                >
                  <Code size={14} weight="duotone" />
                  <span className="practice-pattern">{row.title}</span>
                  <span className="practice-tag practice-tag--mined">{row.family}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
