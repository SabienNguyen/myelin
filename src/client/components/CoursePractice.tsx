// The course bank's Library surface: which problem sets and past exams have been banked, and how
// much of each is still undrilled. Deliberately a LIST, not a launcher — the problems are the
// tutor's to present (verbatim, inside a session plan or on request), so a row here is a fact
// about the learner's material, not a button. Same section grammar as ReviewQueue.
import { useEffect, useState } from 'react';
import { ExamIcon as Exam } from '@phosphor-icons/react';

interface BankSource { source: string; problems: number; fresh: number }

export function CoursePractice({ visible = true }: { visible?: boolean }) {
  const [sources, setSources] = useState<BankSource[] | null>(null);

  // Polled, not fetched once: the section's whole first impression is "I uploaded my exam and the
  // Library now says so" — a single fetch on tab-visibility left it blank until the learner
  // happened to switch tabs (the audit drive caught exactly that). Same cadence as the queue poll.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const load = () => fetch('/api/course-bank')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setSources(d.sources ?? []); })
      .catch(() => { /* an empty bank is a quiet state, not an error banner — the Library still works */ });
    load();
    const id = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [visible]);

  if (!sources || sources.length === 0) return null;

  return (
    <section className="course-practice">
      <h3><Exam size={16} weight="duotone" /> Course practice</h3>
      <p className="course-practice-lede">
        Banked verbatim from your own material — the tutor drills these in session plans.
      </p>
      <ul>
        {sources.map((s) => (
          <li key={s.source}>
            <span className="course-source">{s.source}</span>
            <span className="course-counts">
              {s.problems} {s.problems === 1 ? 'problem' : 'problems'}
              {' · '}
              {s.fresh === 0 ? 'all answered' : `${s.fresh} never answered`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
