import type { MasteryGraph, Point } from './buildGraph.js';

export const POSITIONS_KEY = 'myelin.graph.positions.v1';
export const MAX_REMEMBERED = 20_000;

function isPoint(value: unknown): value is Point {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y);
}

// `storage` defaults to globalThis.localStorage, but accessing it can itself throw (Safari private
// mode, some sandboxes) or simply not exist (SSR, jsdom without a storage shim) — resolve it once
// here so both loadPositions and savePositions degrade the same way instead of crashing the caller.
function resolveStorage(storage: Storage | null | undefined): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadPositions(storage?: Storage | null): Map<string, Point> {
  const s = resolveStorage(storage);
  if (!s) return new Map();

  let raw: string | null;
  try {
    raw = s.getItem(POSITIONS_KEY);
  } catch (err) {
    console.warn('[graph] could not read stored node positions, starting fresh:', err);
    return new Map();
  }
  if (!raw) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[graph] stored node positions are not valid JSON, starting fresh:', err);
    return new Map();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[graph] stored node positions have an unexpected shape, starting fresh');
    return new Map();
  }

  const result = new Map<string, Point>();
  for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isPoint(value)) result.set(slug, { x: value.x, y: value.y });
  }
  return result;
}

export function savePositions(graph: MasteryGraph, storage?: Storage | null): void {
  const s = resolveStorage(storage);
  if (!s) return;

  // Merge over whatever is already there so a save from a scoped subgraph view doesn't forget the
  // rest of the vault's remembered positions.
  const merged = loadPositions(s);
  graph.forEachNode((slug, attrs) => {
    if (!Number.isFinite(attrs.x) || !Number.isFinite(attrs.y)) return;
    // Delete-then-set moves this slug to the end of Map's insertion order, which is how the cap
    // below tells "newest write" from "stale entry" without keeping a separate timestamp per node.
    merged.delete(slug);
    merged.set(slug, { x: attrs.x, y: attrs.y });
  });

  while (merged.size > MAX_REMEMBERED) {
    const oldest = merged.keys().next().value;
    if (oldest === undefined) break;
    merged.delete(oldest);
  }

  const obj: Record<string, Point> = {};
  for (const [slug, point] of merged) obj[slug] = point;
  try {
    s.setItem(POSITIONS_KEY, JSON.stringify(obj));
  } catch (err) {
    console.warn('[graph] failed to save node positions:', err);
  }
}
