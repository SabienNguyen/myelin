// Ported VERBATIM (logic unchanged; only the local `./detectors.js` import path is already
// relative-correct) from ~/Dev/personal/the-gap apps/web/src/OfferPanel.tsx (READ ONLY there).
//
// Ambient offer chrome: "All offers are dismissible side panels, never modal, labeled 'you look
// like you might be here — ignore me if not.'" OfferCard is the shared card wrapper (label +
// dismiss '×') used by PlanPanel/PredictRunPanel/DocsPanel; OfferPanel lays the active offers out
// as a right-side column that sits ALONGSIDE the editor (a CSS sibling, not an overlay) — see
// ../../../styles.css's `.code-exercise-columns` / `.offer-panel` rules. Nothing here ever blocks
// input to the editor: an offer card renders or it doesn't, there is no backdrop.

import type { ReactNode } from 'react';
import type { Offers } from './detectors.js';
import { PlanPanel } from './PlanPanel.js';
import { PredictRunPanel } from './PredictRunPanel.js';
import { DocsPanel } from './DocsPanel.js';

export const OFFER_LABEL = 'you look like you might be here — ignore me if not.';

export function OfferCard({ onDismiss, children }: { onDismiss: () => void; children: ReactNode }) {
  return (
    <div className="offer-card">
      <div className="offer-card-header">
        <span className="offer-card-label">{OFFER_LABEL}</span>
        <button type="button" className="offer-card-dismiss" aria-label="dismiss" onClick={onDismiss}>
          ×
        </button>
      </div>
      <div className="offer-card-body">{children}</div>
    </div>
  );
}

export interface OfferPanelProps {
  offers: Offers;
  artifactId: string;
  rungId: string;
  code: string;
  planText: string;
  onPlanTextChange: (text: string) => void;
  onDismissPlan: () => void;
  onDismissPredictRun: () => void;
  onDismissDocs: () => void;
}

export function OfferPanel({
  offers,
  artifactId,
  rungId,
  code,
  planText,
  onPlanTextChange,
  onDismissPlan,
  onDismissPredictRun,
  onDismissDocs,
}: OfferPanelProps) {
  if (!offers.plan && !offers.predictRun && !offers.docs) return null;

  return (
    <aside className="offer-panel" aria-label="ambient offers">
      {offers.plan && (
        <OfferCard onDismiss={onDismissPlan}>
          <PlanPanel artifactId={artifactId} value={planText} onChange={onPlanTextChange} />
        </OfferCard>
      )}
      {offers.predictRun && (
        <OfferCard onDismiss={onDismissPredictRun}>
          <PredictRunPanel artifactId={artifactId} rungId={rungId} code={code} />
        </OfferCard>
      )}
      {offers.docs && (
        <OfferCard onDismiss={onDismissDocs}>
          <DocsPanel artifactId={artifactId} />
        </OfferCard>
      )}
    </aside>
  );
}
