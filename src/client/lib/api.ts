export const getGraph = () => fetch('/api/graph').then((r) => r.json());
export const getPage = (slug: string) => fetch(`/api/page/${slug}`).then((r) => r.json());
export const getStatus = () => fetch('/api/status').then((r) => r.json());
