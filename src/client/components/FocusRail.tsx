// P1 (docs/superpowers/plans/2026-07-20-gap-integration.md): the slim strip App.tsx shows in
// place of the chat column while a code_exercise block has focus mode on (see panelBus.ts's
// `focusMode` event and App.tsx's subscription). Always mounted once focus mode is on — CSS
// (`.app.focus-mode`/`.peek` in styles.css) toggles which half of it (this strip's own detail
// bits vs. <Thread/>) is visible, never a conditional unmount, so the exercise itself (which
// lives entirely in the SidePanel's #stage-root, untouched by any of this) never loses state and
// the chat's scroll position/composer draft survive a peek round-trip.
//
// "clicking expands chat back, exercise stays live" (spec) is the SAME toggle both ways: the one
// button here flips `peek`, and while peeking this same strip stays visible above the reopened
// chat as a "back to exercise" way to re-collapse.

import { CodeIcon as Code } from '@phosphor-icons/react';
import { useLastAssistantLine } from '../lib/useLastAssistantLine.js';

export function FocusRail({ peek, onTogglePeek }: { peek: boolean; onTogglePeek: () => void }) {
  const lastLine = useLastAssistantLine();

  return (
    <div className="focus-rail">
      <button type="button" className="focus-rail-toggle" onClick={onTogglePeek}>
        {peek ? 'back to exercise' : 'back to tutor'}
      </button>
      {!peek && (
        <div className="focus-rail-detail">
          {lastLine && <p className="focus-rail-lastline" title={lastLine}>{lastLine}</p>}
          <span className="focus-rail-chip" aria-hidden="true">
            <Code size={15} weight="duotone" /> Code exercise waiting on the stage
          </span>
        </div>
      )}
    </div>
  );
}
