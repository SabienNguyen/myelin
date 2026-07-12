import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { panelBus } from '../lib/panelBus.js';

export function StagePortal({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById('stage-root'));
    panelBus.setTab('stage');
  }, []);
  return target ? createPortal(children, target) : null;
}
