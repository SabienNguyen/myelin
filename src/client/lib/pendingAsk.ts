// A first message handed from a screen outside the chat (the notebook view's "Study now") to a
// conversation that is not mounted yet. The notebook view files a fresh thread, leaves the text
// here and navigates; the thread sends it once, on mount. sessionStorage, not a module variable:
// it has to survive the App re-render that swaps the notebook screen for the workspace, and it
// belongs to this tab only. Storage can be unavailable (private windows, blocked site data), so a
// failure is logged and the conversation simply opens empty — the learner can still type.
const key = (threadId: string) => `myelin.pendingAsk.${threadId}`;

export function setPendingAsk(threadId: string, text: string): void {
  try {
    sessionStorage.setItem(key(threadId), text);
  } catch (e) {
    console.error('[pending-ask] could not hand the first message to the new conversation:', e);
  }
}

/** Returns the waiting message for this thread and forgets it, so it is sent exactly once. */
export function takePendingAsk(threadId: string): string | null {
  try {
    const text = sessionStorage.getItem(key(threadId));
    if (text !== null) sessionStorage.removeItem(key(threadId));
    return text;
  } catch (e) {
    console.error('[pending-ask] could not read the waiting first message:', e);
    return null;
  }
}
