// One canonical JSON serialization, shared by the non-child graders that compare VALUES for
// equality (service.ts's predict path, manifest.ts's `eq` assertion). Object keys are sorted
// recursively, so a comparison is by CONTENT, not by the order keys happened to be written:
// a function that returns { b, a } equals { a, b }, and a Kubernetes label map { tier, app }
// equals { app, tier } (YAML maps are unordered). Arrays keep their order — sequence is meaning.
//
// The child runner (runner.ts) carries its OWN copy of this logic on purpose: its comparison runs
// inside the self-contained CHILD_SOURCE string passed to a child process via `-e`, which cannot
// import a module. This file serves every in-process caller so they don't each grow a copy.
export function canonicalJSON(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (x === null || typeof x !== 'object') return x;
    if (Array.isArray(x)) return x.map(sort);
    return Object.keys(x as Record<string, unknown>).sort().reduce((o, k) => {
      o[k] = sort((x as Record<string, unknown>)[k]);
      return o;
    }, {} as Record<string, unknown>);
  };
  return JSON.stringify(sort(v));
}
