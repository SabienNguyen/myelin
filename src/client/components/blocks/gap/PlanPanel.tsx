// Ported (import adaptation — ./handWrittenProse.js instead of ./server/handWrittenProse.js,
// since the harness ports only the client-facing constants, not the gap's server-side prose
// overlay) from ~/Dev/personal/the-gap apps/web/src/PlanPanel.tsx (READ ONLY there). Logic
// unchanged.
//
// The plan-writing offer: "textarea 'write your steps in English'; below it, per-rung concept
// checklist ... each concept lights up (neutral styling) when the plan text matches its regex.
// NEVER generates or suggests code." Controlled by the parent (CodeExercise.tsx owns `planText`
// state, not this component) so the text SURVIVES the panel being unmounted when the idle-offer
// condition goes false and later re-offered.

import { PLAN_CONCEPTS_BY_ARTIFACT } from './handWrittenProse.js';

export interface PlanPanelProps {
  artifactId: string;
  value: string;
  onChange: (text: string) => void;
}

export function PlanPanel({ artifactId, value, onChange }: PlanPanelProps) {
  const concepts = PLAN_CONCEPTS_BY_ARTIFACT[artifactId] ?? [];

  return (
    <div className="plan-panel">
      <label className="plan-panel-label" htmlFor="plan-panel-textarea">
        write your steps in English
      </label>
      <textarea
        id="plan-panel-textarea"
        className="plan-panel-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {concepts.length > 0 && (
        <ul className="plan-panel-concepts" aria-label="concepts your plan mentions">
          {concepts.map((concept) => {
            const mentioned = concept.pattern.test(value);
            return (
              <li
                key={concept.label}
                className={mentioned ? 'plan-concept plan-concept--lit' : 'plan-concept'}
                data-mentioned={mentioned}
              >
                {concept.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
