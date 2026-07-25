export const getGraph = () => fetch('/api/graph').then((r) => r.json());
export const getPage = (slug: string) => fetch(`/api/page/${slug}`).then((r) => r.json());
export const getStatus = () => fetch('/api/status').then((r) => r.json());

// Paths + goal (goalStore.ts / restRoutes.ts). `known` counts EFFECTIVE practicing-or-better, so
// these numbers move down when mastery decays, not only up.
export interface PathRow {
  slug: string; title: string; pages: string[];
  known: number; total: number; nextSlug: string | null;
}
export interface Goal { kind: 'path' | 'page'; slug: string; setOn: string }
export interface PathsPayload { goal: Goal | null; paths: PathRow[] }

export const getPaths = (): Promise<PathsPayload> =>
  fetch('/api/paths').then((r) => {
    if (!r.ok) throw new Error(`GET /api/paths failed: ${r.status}`);
    return r.json();
  });

export const setGoal = (goal: { kind: 'path' | 'page'; slug: string } | null): Promise<Goal | null> =>
  fetch('/api/goal', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(goal),
  }).then((r) => {
    if (!r.ok) throw new Error(`PUT /api/goal failed: ${r.status}`);
    return r.json();
  });
