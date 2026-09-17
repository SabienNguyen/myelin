/** Drain a response independently of its HTTP subscriber. Cancelling the subscriber drops
 * delivery only; the producer still runs and persists its final result. No replay buffer. */
export function detachedResponse(response: Response, onEnd: () => void): Response {
  if (!response.body) {
    onEnd();
    return response;
  }
  const reader = response.body.getReader();
  let connected = true;
  const body = new ReadableStream<Uint8Array>({
    cancel() { connected = false; },
    start(controller) {
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (connected) controller.enqueue(value);
          }
          if (connected) controller.close();
        } catch (error) {
          if (connected) controller.error(error);
        } finally {
          reader.releaseLock();
          onEnd();
        }
      })();
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}
