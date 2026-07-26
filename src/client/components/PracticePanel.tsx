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

// A generated exercise the machine verified but nobody has accepted yet. The review gate existed
// server-side from the start; what did NOT exist was any way to review from the app — approval
// took curl, which for a desktop app means the pending list was a place exercises went to die.
// In a single-user app the learner IS the reviewer, so the gate lives here, one click deep.
interface PendingRow {
  pattern: string;
  title: string;
  family: string;
  gatesPassed: number;
}

export function PracticePanel({ visible = true }: { visible?: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [mined, setMined] = useState<MinedRow[]>([]);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const threadRuntime = useThreadRuntime();

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      // The review queue — a route only the built-in sandbox has; its absence (external sidecar)
      // simply means no queue to show.
      const genRes = await fetch('/api/gap/generated').catch(() => null);
      if (genRes?.ok && !cancelled) {
        const { exercises } = await genRes.json();
        setPending((Array.isArray(exercises) ? exercises : [])
          .filter((e: any) => e.status === 'pending' && e.verification?.ok)
          .map((e: any): PendingRow => ({
            pattern: e.pattern, title: e.title ?? e.pattern, family: e.family ?? 'stream',
            gatesPassed: (e.verification?.gates ?? []).filter((g: any) => g.ok).length,
          })));
      }
    })();
    return () => { cancelled = true; };
  }, [visible, refresh]);

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
  }, [visible, refresh]);

  const decide = async (pattern: string, status: 'approved' | 'rejected') => {
    setDeciding(pattern);
    try {
      await fetch(`/api/gap/generated/${pattern}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    } finally {
      setDeciding(null);
      setRefresh((n) => n + 1); // an approved pattern re-fetches into the Practice list itself
    }
  };

  if (rows === null) return null;
  if (rows.length === 0 && mined.length === 0 && pending.length === 0) return null;

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
      {pending.length > 0 && (
        <>
          <h4 className="practice-group-label">Waiting for your approval</h4>
          <ul>
            {pending.map((p) => (
              <li key={p.pattern} className="practice-pending">
                <div className="practice-pending-head">
                  <Code size={14} weight="duotone" />
                  <span className="practice-pattern">{p.title}</span>
                  <span className="practice-tag practice-tag--new">{p.family}</span>
                </div>
                <p className="practice-pending-note">
                  Authored by the tutor, passed {p.gatesPassed} mechanical checks. Look right?
                </p>
                <div className="practice-pending-actions">
                  <button type="button" disabled={deciding === p.pattern} onClick={() => decide(p.pattern, 'approved')}>
                    Approve — add to Practice
                  </button>
                  <button type="button" className="ghost-btn" disabled={deciding === p.pattern} onClick={() => decide(p.pattern, 'rejected')}>
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
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
