// P1 (docs/superpowers/plans/2026-07-20-gap-integration.md): feeds FocusRail's "tutor's last text
// line, truncated" — read straight off the thread runtime's own snapshot/subscribe pair (the same
// `useThreadRuntime()` already used by GraphPanel.tsx/PracticePanel.tsx) rather than assistant-ui's
// scoped `useThread` selector hook, so it composes with those components' existing test-mocking
// pattern (`vi.mock('@assistant-ui/react', ...)` overriding just `useThreadRuntime`).

import { useEffect, useState } from 'react';
import { useThreadRuntime } from '@assistant-ui/react';

/** Last non-empty line of the most recent assistant message's text content, or '' if there isn't
 *  one yet (a fresh thread, or the assistant hasn't said anything with text in it). */
export function useLastAssistantLine(): string {
  const threadRuntime = useThreadRuntime();
  const [line, setLine] = useState('');

  useEffect(() => {
    function read(): void {
      const messages = threadRuntime.getState().messages;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'assistant') continue;
        const text = m.content
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join(' ')
          .trim();
        if (text) {
          const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
          setLine(lines[lines.length - 1] ?? '');
          return;
        }
      }
      setLine('');
    }
    read();
    return threadRuntime.subscribe(read);
  }, [threadRuntime]);

  return line;
}
