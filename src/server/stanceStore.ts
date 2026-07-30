// Per-thread teaching stance — vault/.harness/stances.json, a single { threadId: stance } map.
// Same sidecar territory as usageLedger/queueStore, same graceful-read: a corrupt or absent file
// reads as "no stances", never a failed turn. Mutations are synchronous read-merge-write with no
// await between read and write, so (like sessionStore) no mutex is needed — Node never preempts
// synchronous code, and nothing here holds the map across an await.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isStance, type Stance } from '../shared/commands.js';

/** What each stance means, in the tutor's operating terms. One source of truth: session.ts's
 * tail HARNESS note and rails' generation prompts both read from here, so the agentic and rails
 * paths can never describe the same stance differently. */
export const STANCE_INSTRUCTIONS: Record<Stance, string> = {
  beginner: 'explain from zero — define every term on first use, give a concrete analogy before '
    + 'any formalism, keep steps short, and drop in a quick check every few steps; when '
    + 'researching, favor introductory and tutorial sources over papers',
  intermediate: 'assume the foundations hold — connect each new idea to something adjacent the '
    + 'student already knows, keep a moderate pace, and mix concrete examples with the formal '
    + 'statement',
  advanced: 'assume fluency — reach for primary sources and papers first, stay terse and '
    + 'depth-first, and lead with the edge cases and limitations rather than the happy path',
};

const storePath = (vault: string) => join(vault, '.harness', 'stances.json');

/** The whole map. Unknown values are dropped on read (a hand-edited or version-skewed file must
 * not smuggle an arbitrary string into a prompt), so every returned value is a real Stance. */
export function readStances(vault: string): Record<string, Stance> {
  const p = storePath(vault);
  if (!existsSync(p)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {}; // corrupt sidecar reads as empty — same stance as readQueue/readUsage
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, Stance> = {};
  for (const [threadId, stance] of Object.entries(parsed)) {
    if (isStance(stance)) out[threadId] = stance;
  }
  return out;
}

export function readStance(vault: string, threadId: string): Stance | null {
  return readStances(vault)[threadId] ?? null;
}

export function setStance(vault: string, threadId: string, stance: Stance): void {
  mkdirSync(join(vault, '.harness'), { recursive: true });
  writeFileSync(storePath(vault), JSON.stringify({ ...readStances(vault), [threadId]: stance }, null, 2));
}

/** Drop a thread's stance — chatRoute's DELETE calls this beside deleteThread, so a deleted
 * conversation's stance cannot leak into a future thread that reuses the id. */
export function clearStance(vault: string, threadId: string): void {
  const stances = readStances(vault);
  if (!(threadId in stances)) return;
  delete stances[threadId];
  writeFileSync(storePath(vault), JSON.stringify(stances, null, 2));
}
