/** Drain a response independently of its HTTP subscriber. Cancelling the subscriber drops
 * delivery only; the producer still runs and persists its final result. No replay buffer.
 *
 * `idle` bounds that independence. Closing the tab used to be what ended a turn whose provider
 * stream had stalled — both model adapters time out only while waiting for headers, never
 * mid-body. Detached, nothing ended it: the run stayed registered, and the thread answered 409 to
 * every send, save and delete until the server restarted. When no chunk has arrived for
 * `idle.ms`, `idle.onIdle` is called (the caller aborts the turn) and the read is cancelled, so
 * the stream ends and `onEnd` fires either way. */
export function detachedResponse(
  response: Response, onEnd: () => void, idle?: { ms: number; onIdle: () => void },
): Response {
  if (!response.body) {
    onEnd();
    return response;
  }
  const reader = response.body.getReader();
  let connected = true;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (!idle) return;
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      console.error(`[chat] no output for ${idle.ms}ms — ending the turn rather than holding its thread`);
      idle.onIdle();
      reader.cancel().catch(() => { /* already ended by the abort above */ });
    }, idle.ms);
  };
  const body = new ReadableStream<Uint8Array>({
    cancel() { connected = false; },
    start(controller) {
      void (async () => {
        try {
          for (;;) {
            arm();
            const { done, value } = await reader.read();
            if (done) break;
            if (connected) controller.enqueue(value);
          }
          if (connected) controller.close();
        } catch (error) {
          if (connected) controller.error(error);
        } finally {
          clearTimeout(watchdog);
          reader.releaseLock();
          onEnd();
        }
      })();
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}
