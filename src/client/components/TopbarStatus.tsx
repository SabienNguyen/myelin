import { useEffect, useRef, useState } from 'react';
import { BrainIcon as Brain, UserCircleIcon as UserCircle } from '@phosphor-icons/react';

type Status = { anki?: 'up' | 'down' | 'backlog'; student?: string; tutor?: string };

const ANKI_LABEL: Record<string, string> = {
  up: 'Anki connected',
  down: 'Anki closed — reviews sync when it opens',
  backlog: 'Anki has a review backlog',
};

/**
 * The tutor model, said in words rather than in a model id.
 *
 * The badge used to read `claude-sdk:sonnet`, which is an implementation detail of how the harness
 * routes a request — and on a first run it is the second thing in the toolbar, next to the learner's
 * own name. What they actually want to know is which model and whose bill.
 */
export function modelLabel(id: string): { name: string; how: string } {
  const pretty = (m: string) => m
    .replace(/^claude-/, '')
    .replace(/-(\d)-(\d)$/, ' $1.$2')     // haiku-4-5 -> haiku 4.5
    .replace(/-(\d+)$/, ' $1')             // sonnet-5   -> sonnet 5
    .replace(/^(.)/, (c) => c.toUpperCase());
  if (id.startsWith('claude-sdk:')) {
    return { name: pretty(id.slice('claude-sdk:'.length)), how: 'Claude subscription' };
  }
  if (id.startsWith('ollama:')) {
    return { name: id.slice('ollama:'.length), how: 'local model via Ollama' };
  }
  return { name: pretty(id), how: 'Anthropic API' };
}

export function TopbarStatus() {
  const [status, setStatus] = useState<Status>({});
  useEffect(() => {
    let cancelled = false;
    const load = () => fetch('/api/status').then((r) => r.json())
      .then((s) => { if (!cancelled) setStatus(s); }).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  return (
    <div className="topbar-status">
      {status.student && <StudentSwitcher current={status.student} onSwitched={(name) => setStatus((s) => ({ ...s, student: name }))} />}
      {status.tutor && (() => {
        const { name, how } = modelLabel(status.tutor);
        return (
          <span className="badge" title={`Tutor model: ${name}, via ${how} (${status.tutor})`}>
            <Brain size={14} weight="duotone" /> {name}
          </span>
        );
      })()}
      {/* 'down' is omitted, not shown greyed: on a first run nobody has Anki installed, and an
          amber badge for a feature the learner never asked for reads as "something is broken".
          A backlog IS worth flagging — that one is about work they have already done. */}
      {/* role=status + aria-label, not title alone: a tooltip on an unfocusable span is invisible
          to the keyboard and unreliable for screen readers, and the dot's COLOR was the only other
          carrier of which state this is. */}
      {status.anki && status.anki !== 'down' && (
        <span
          className={`badge anki-${status.anki}`} title={ANKI_LABEL[status.anki]}
          role="status" aria-label={ANKI_LABEL[status.anki]}
        >
          <span className="statusdot" aria-hidden="true" /> anki
        </span>
      )}
    </div>
  );
}


/**
 * The student badge, grown into a switcher: one vault, several learners, separate evidence —
 * loreweaver has always keyed the student model by id, and this is the surface that lets a
 * household actually use that. Menu lists known students (anyone with a state file) plus a
 * field for a new name; switching takes effect on the next request and persists.
 */
function StudentSwitcher({ current, onSwitched }: { current: string; onSwitched: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [students, setStudents] = useState<string[]>([]);
  const [fresh, setFresh] = useState('');
  const [voice, setVoice] = useState('');
  const [note, setNote] = useState('');
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    fetch('/api/students').then((r) => r.json())
      .then((d) => setStudents(d.students ?? [])).catch(() => {});
    fetch('/api/voice').then((r) => r.json()).then((d) => setVoice(d.voice ?? '')).catch(() => {});
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const switchTo = async (name: string) => {
    const res = await fetch('/api/student', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setNote(d.error ?? 'could not switch'); return; }
    setNote(d.warning ?? '');
    onSwitched(d.current);
    setOpen(false);
    setFresh('');
  };

  return (
    <span className="student-switcher" ref={rootRef}>
      <button
        type="button" className="badge student-badge"
        aria-haspopup="menu" aria-expanded={open}
        aria-label={`student: ${current} — switch student`}
        onClick={() => setOpen((o) => !o)}
      >
        <UserCircle size={14} weight="duotone" /> {current}
      </button>
      {open && (
        <span className="student-menu" role="menu" aria-label="switch student">
          {students.map((s) => (
            <button key={s} type="button" role="menuitem" className={s === current ? 'on' : ''}
              onClick={() => (s === current ? setOpen(false) : switchTo(s))}>
              {s}{s === current ? ' \u00b7 current' : ''}
            </button>
          ))}
          {/* Tone is a profile preference, so it lives with the profile: one line the tutor
              honors in HOW it teaches — never in what counts as evidence. */}
          <input
            aria-label="teaching style"
            placeholder="teaching style — e.g. high school, no jargon"
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            onBlur={() => { void fetch('/api/voice', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice }) }); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
          <input
            aria-label="new student name"
            placeholder="new student\u2026"
            value={fresh}
            onChange={(e) => setFresh(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && fresh.trim()) void switchTo(fresh.trim()); }}
          />
          {note && <span className="student-note" role="status">{note}</span>}
        </span>
      )}
    </span>
  );
}
