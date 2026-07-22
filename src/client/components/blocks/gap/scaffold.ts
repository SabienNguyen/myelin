// RungEditor v2 (docs/superpowers/plans/2026-07-21-coding-stage.md, "one fully-editable
// whole-file editor" — see RungEditor.tsx's top comment for why the old 3-pane pre/gap/post
// approach was retired): the sidecar now computes a `scaffold` field server-side for every served
// rung, built-in and mined alike — visible_pre + an indented "YOUR TURN" task-marker comment
// replacing the gap + visible_post, i.e. the complete answer-stripped file a whole-file editor can
// load directly (see the-gap repo's apps/web/src/server/scaffold.ts, buildScaffold — the server
// side of this exact same marker format).
//
// synthesizeScaffold is the CLIENT-SIDE fallback for a rung whose sidecar response predates that
// field (a stale sidecar — resilience, not the common case): same marker wording/shape, but
// indentation only ever comes from visible_pre's own trailing whitespace (the beginning-of-line
// gap shape) — never from reference_answer, which the client never receives for a non-
// worked_example rung anyway (see gapProxy.ts's top comment on that stripping), so there is no
// richer signal available here than the server's own mid-line-gap case uses.
//
// resolveScaffold is the one call site every caller (RungEditor's callers, not RungEditor itself)
// should use to get a rung's loadable whole-file doc.
//
// findMarkerLineRange locates the marker's own lines in a doc's CURRENT text (server-built or
// synthesized, doesn't matter which — both use this exact wording) for RungEditor's decoration.

import type { Rung } from './types.js';

const MARKER_TOP = '── YOUR TURN ─────────────────────────────────────';
const MARKER_BOTTOM = '──────────────────────────────────────────────────';
const FALLBACK_TASK = 'Write your code here.';

function deriveIndent(visiblePre: string): string {
  const lines = visiblePre.split('\n');
  const last = lines[lines.length - 1];
  return /^[ \t]*$/.test(last) ? last : '';
}

/** Client-side fallback scaffold synthesis — see this file's top comment. Never reads
 *  reference_answer (the caller doesn't have it to give); the only two inputs are the same
 *  answer-free strings every rung already carries. */
export function synthesizeScaffold(visiblePre: string, visiblePost: string): string {
  const indent = deriveIndent(visiblePre);
  const marker = [`${indent}// ${MARKER_TOP}`, `${indent}// ${FALLBACK_TASK}`, `${indent}// ${MARKER_BOTTOM}`]
    .join('\n');

  // Strip the trailing whitespace-only tail off visible_pre (that's the BOL indent already folded
  // into `indent` above, about to be re-supplied by the marker's own first line), then guarantee
  // exactly one newline before the marker.
  const preTrimmed = visiblePre.replace(/[ \t]*$/, '');
  const preWithNewline = preTrimmed.length === 0 || preTrimmed.endsWith('\n') ? preTrimmed : `${preTrimmed}\n`;

  // Only add a newline after the marker when visible_post doesn't already start with one — keeps
  // the original file's blank-line count around the gap intact either way.
  const glue = visiblePost.startsWith('\n') ? '' : '\n';

  return `${preWithNewline}${marker}${glue}${visiblePost}`;
}

/** The one call site every caller should use to get a rung's loadable whole-file doc: the
 *  server-computed field when present, the client fallback otherwise. */
export function resolveScaffold(rung: Pick<Rung, 'scaffold' | 'visible_pre' | 'visible_post'>): string {
  return rung.scaffold ?? synthesizeScaffold(rung.visible_pre, rung.visible_post);
}

function isCommentLine(line: string): boolean {
  return /^\s*\/\//.test(line);
}

function isBorderLine(line: string): boolean {
  return /^\s*\/\/\s*─+\s*$/.test(line);
}

/** Locates the marker's own lines in `text`, 1-indexed (matches CM6's `doc.line()` convention),
 *  for RungEditor's line decoration. Anchored on the first `//`-comment line mentioning "YOUR
 *  TURN" (the marker's own top border), extended downward through contiguous `//`-comment lines
 *  up to and including its closing all-dashes border line — so a comment the learner happens to
 *  type right after the marker never gets swept in once the block has properly closed. Returns
 *  null when no such line exists: the learner deleted the marker entirely, or it was never there.
 *  RungEditor.tsx's decoration just renders nothing in that case — never blocked, never
 *  restored. */
export function findMarkerLineRange(text: string): { startLine: number; endLine: number } | null {
  const lines = text.split('\n');
  const topIndex = lines.findIndex((line) => isCommentLine(line) && line.includes('YOUR TURN'));
  if (topIndex === -1) return null;

  let endIndex = topIndex;
  while (endIndex < lines.length - 1 && !isBorderLine(lines[endIndex]) && isCommentLine(lines[endIndex + 1])) {
    endIndex += 1;
  }
  return { startLine: topIndex + 1, endLine: endIndex + 1 };
}
