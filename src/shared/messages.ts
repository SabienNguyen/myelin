/** Drop duplicate messages by their string `id`, keeping the LAST occurrence of each id (the
 * later copy is the more complete re-persist) and preserving the relative order of survivors.
 * Messages without a string `id` are never deduped against anything — they're always kept.
 *
 * Guards against a corrupt saved thread (e.g. two messages sharing an id) reaching
 * assistant-ui's MessageRepository, which throws "A message with the same id already exists"
 * on restore and blanks the entire app at mount. */
export function dedupeById(messages: unknown[]): unknown[] {
  const idOf = (m: unknown): string | undefined => {
    const id = (m as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? id : undefined;
  };

  const lastIndexById = new Map<string, number>();
  messages.forEach((m, i) => {
    const id = idOf(m);
    if (id !== undefined) lastIndexById.set(id, i);
  });

  return messages.filter((m, i) => {
    const id = idOf(m);
    return id === undefined || lastIndexById.get(id) === i;
  });
}
