// P1 (docs/superpowers/plans/2026-07-20-gap-integration.md): the CodeSignal-grade IDE shell
// shared by all three rungs (worked_example / inline_completion / full_body) so a ladder walk
// feels like one continuous IDE session, not three differently-shaped screens. Three regions:
// a left "brief" panel (pattern title, the rung's context/contract line, the ladder step
// indicator, and a small tab strip) and a right region that's just whatever the caller passes
// as `children` (WorkedExample / InlineCompletion / the full_body editor+console column).
//
// The ambient offers (plan/predict/docs — detectors.ts, unchanged) dock here as brief-panel
// tabs instead of the old floating aside card: CodeExercise.tsx builds a `tabs` array with one
// entry per offer that's CURRENTLY firing (so a tab existing at all IS the "light" — this keeps
// the exact same gating detectors.ts already enforces, just relocated) plus an always-present
// 'task' tab. Tab content marked `onDismiss` renders inside the gap's own OfferCard chrome (same
// "you look like you might be here — ignore me if not." label + × dismiss button) so dismissal
// keeps its existing dismissible-not-modal contract.

import { useEffect, useState, type ReactNode } from 'react';
import { OfferCard } from './OfferPanel.js';

export interface BriefTab {
  key: string;
  label: string;
  /** Shows a small "lit" badge next to the tab label — true for every offer tab (a tab only
   *  exists while its detector is firing, so this is always true for those; false for 'task'). */
  active: boolean;
  content: ReactNode;
  /** Present only on offer tabs — wraps `content` in the shared ambient-offer chrome. */
  onDismiss?: () => void;
}

export interface FocusLayoutProps {
  patternTitle: string;
  contextLine?: string;
  ladder?: { steps: string[]; stepIndex: number };
  tabs: BriefTab[];
  children: ReactNode;
}

export function FocusLayout({ patternTitle, contextLine, ladder, tabs, children }: FocusLayoutProps) {
  const [activeKey, setActiveKey] = useState(tabs[0]?.key ?? 'task');

  // An offer tab can vanish out from under the active selection (its detector state flips back
  // to false — e.g. the learner fixed the syntax error before ever opening the tab, or dismissed
  // it) — fall back to 'task' rather than showing an empty panel.
  useEffect(() => {
    if (!tabs.some((t) => t.key === activeKey)) setActiveKey(tabs[0]?.key ?? 'task');
  }, [tabs, activeKey]);

  const active = tabs.find((t) => t.key === activeKey) ?? tabs[0];

  return (
    <div className="ide-focus">
      <div className="ide-brief">
        <h2 className="ide-brief-title">{patternTitle}</h2>
        {contextLine !== undefined && <p className="ide-brief-context">{contextLine}</p>}

        {ladder && (
          <nav className="ladder-steps" aria-label="ladder progress">
            {ladder.steps.map((label, i) => (
              <span
                key={label}
                className={i === ladder.stepIndex ? 'ladder-step ladder-step--current' : 'ladder-step'}
                aria-current={i === ladder.stepIndex ? 'step' : undefined}
              >
                {label}
              </span>
            ))}
          </nav>
        )}

        <nav className="ide-brief-tabs" role="tablist" aria-label="exercise panel">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={t.key === active?.key}
              className={t.key === active?.key ? 'ide-tab ide-tab--active' : 'ide-tab'}
              onClick={() => setActiveKey(t.key)}
            >
              {t.label}
              {t.active && <span className="ide-tab-badge" aria-hidden="true" />}
            </button>
          ))}
        </nav>

        <div className="ide-brief-body" role="tabpanel">
          {active?.onDismiss ? <OfferCard onDismiss={active.onDismiss}>{active.content}</OfferCard> : active?.content}
        </div>
      </div>

      <div className="ide-editor-region">{children}</div>
    </div>
  );
}
