/**
 * Every read here used to be `fetch(path).then((r) => r.json())` with no status check. When the
 * dev proxy answers 502 with an empty or HTML body — which happens whenever the backend is
 * restarting — `.json()` rejects with "Unexpected end of JSON input", and that surfaced to the
 * learner either as an uncaught pageerror or as a panel stuck on "Loading…" forever. A failed
 * request and a slow one looked identical.
 *
 * `getJson` collapses all three failure modes (unreachable, non-2xx, unparseable) into one typed
 * error whose MESSAGE is written for a learner: it names what could not be loaded, never an HTTP
 * method and path. design.md's copy rule wants "what failed and what the user can do", and
 * "GET /api/graph failed: 502" is neither. The method, path and status stay on the error object
 * for anyone logging it — they are diagnostics, not copy.
 */
export class ApiError extends Error {
  constructor(readonly path: string, readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJson<T>(path: string, subject: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path);
  } catch {
    // Nothing answered at all — a different problem from a server that answered badly, and the
    // only one where the user has an obvious action.
    throw new ApiError(path, 0, `Can’t reach the harness — check that the server is running.`);
  }
  if (!res.ok) {
    throw new ApiError(path, res.status, res.status >= 500
      ? `Couldn’t load ${subject} — the harness hit an error (${res.status}).`
      : `Couldn’t load ${subject} — the harness returned ${res.status}.`);
  }
  try {
    return await res.json() as T;
  } catch {
    // A 2xx with a body that isn't JSON: almost always a proxy or dev-server page standing in for
    // the real backend. Saying "not readable" beats leaking a JSON parser's error text.
    throw new ApiError(path, res.status, `Couldn’t load ${subject} — the reply wasn’t readable.`);
  }
}

export const getGraph = () => getJson<any>('/api/graph', 'the concept graph');
// Subject includes the slug so the panel needs no prefix of its own — see PagePanel.
export const getPage = (slug: string) => getJson<any>(`/api/page/${slug}`, `“${slug}”`);
export const getStatus = () => getJson<any>('/api/status', 'the harness status');

// Paths + goal (goalStore.ts / restRoutes.ts). `known` counts EFFECTIVE practicing-or-better, so
// these numbers move down when mastery decays, not only up.
export interface PathRow {
  slug: string; title: string; pages: string[];
  known: number; total: number; nextSlug: string | null;
}
export interface Goal { kind: 'path' | 'page'; slug: string; setOn: string }
export interface PathsPayload { goal: Goal | null; paths: PathRow[] }

export const getPaths = (): Promise<PathsPayload> => getJson<PathsPayload>('/api/paths', 'your learning paths');

export const setGoal = async (goal: { kind: 'path' | 'page'; slug: string } | null): Promise<Goal | null> => {
  let res: Response;
  try {
    res = await fetch('/api/goal', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goal),
    });
  } catch {
    throw new ApiError('/api/goal', 0, `Can’t reach the harness — your goal wasn’t saved.`);
  }
  // A goal that silently failed to save is worse than one that visibly did (restRoutes.ts makes the
  // same argument for answering 400 rather than no-opping), so this stays an error, not a shrug.
  if (!res.ok) throw new ApiError('/api/goal', res.status, `Couldn’t save your goal (${res.status}).`);
  try {
    return await res.json() as Goal | null;
  } catch {
    throw new ApiError('/api/goal', res.status, `Couldn’t save your goal — the reply wasn’t readable.`);
  }
};
