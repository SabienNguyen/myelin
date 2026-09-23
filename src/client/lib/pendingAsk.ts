// A first message handed from a screen outside the chat (the notebook view's "Review due" and
// Studio actions) to a conversation that is not mounted yet. The notebook view files a fresh
// thread, leaves the message here and navigates; the thread sends it once, on mount.
// sessionStorage, not a module variable: it has to survive the App re-render that swaps the
// notebook screen for the workspace, and it belongs to this tab only. Storage can be unavailable
// (private windows, blocked site data), so a failure is logged and the conversation simply opens
// empty — the learner can still type.
import { isCommand, type Command } from '../../shared/commands.js';

export interface PendingAsk { text: string; command?: Command }

const key = (threadId: string) => `myelin.pendingAsk.${threadId}`;

export function setPendingAsk(threadId: string, ask: PendingAsk): void {
  try {
    sessionStorage.setItem(key(threadId), JSON.stringify(ask));
  } catch (e) {
    console.error('[pending-ask] could not hand the first message to the new conversation:', e);
  }
}

/** Returns the waiting message for this thread and forgets it, so it is sent exactly once. A
 *  stored value that is not a message (hand-edited storage, an older build's plain string) is
 *  dropped rather than sent. */
export function takePendingAsk(threadId: string): PendingAsk | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(key(threadId));
    if (raw !== null) sessionStorage.removeItem(key(threadId));
  } catch (e) {
    console.error('[pending-ask] could not read the waiting first message:', e);
    return null;
  }
  if (raw === null) return null;
  try {
    const ask = JSON.parse(raw) as { text?: unknown; command?: unknown };
    if (typeof ask?.text !== 'string' || !ask.text.trim()) return null;
    return { text: ask.text, ...(isCommand(ask.command) ? { command: ask.command } : {}) };
  } catch (e) {
    console.error('[pending-ask] dropped an unreadable waiting message:', e);
    return null;
  }
}
