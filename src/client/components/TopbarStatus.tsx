import { useEffect, useState } from 'react';
import { BrainIcon as Brain, UserCircleIcon as UserCircle } from '@phosphor-icons/react';

type Status = { anki?: 'up' | 'down' | 'backlog'; student?: string; tutor?: string };

const ANKI_LABEL: Record<string, string> = {
  up: 'Anki connected',
  down: 'Anki closed — reviews sync when it opens',
  backlog: 'Anki has a review backlog',
};

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
      {status.student && <span className="badge"><UserCircle size={14} weight="duotone" /> {status.student}</span>}
      {status.tutor && <span className="badge" title="tutor model"><Brain size={14} weight="duotone" /> {status.tutor.replace(/^ollama:/, '')}</span>}
      {status.anki && (
        <span className={`badge anki-${status.anki}`} title={ANKI_LABEL[status.anki]}>
          <span className="statusdot" /> anki
        </span>
      )}
    </div>
  );
}
