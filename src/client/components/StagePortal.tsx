import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { panelBus } from '../lib/panelBus.js';

export function StagePortal({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById('stage-root'));
  }, []);
  // Deferred to its own effect, keyed on target rather than fired inline above: on the first pass
  // target is still null, so this component's children (the exercise) haven't portaled in and
  // mounted yet — firing setTab here would race ahead of the child's own mount effects (App.tsx's
  // focus-mode guard among them) by a full render. Once target is set, the children mount and their
  // effects run first (React fires child effects before parent effects), so this now runs AFTER
  // the exercise has already flipped focus mode on, not before.
  useEffect(() => {
    if (target) panelBus.setTab('stage');
  }, [target]);
  return target ? createPortal(children, target) : null;
}
