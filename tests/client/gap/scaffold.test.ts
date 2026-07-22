// RungEditor v2 (docs/superpowers/plans/2026-07-21-coding-stage.md, "whole-file IDE"): unit tests
// for the pure helpers scaffold.ts exports — no DOM/CM6 involved, see RungEditor.tsx/its own test
// file for how these compose into the actual editor.

import { describe, it, expect } from 'vitest';
import { synthesizeScaffold, resolveScaffold, findMarkerLineRange } from
  '../../../src/client/components/blocks/gap/scaffold.js';

describe('synthesizeScaffold — client-side fallback for a stale sidecar missing `scaffold`', () => {
  it('builds visible_pre + an indented marker + visible_post, indent taken from visible_pre\'s own trailing whitespace', () => {
    const visiblePre = 'export function f() {\n  ';
    const visiblePost = '\n}\n';

    const scaffold = synthesizeScaffold(visiblePre, visiblePost);

    expect(scaffold).toBe(
      'export function f() {\n'
      + '  // ── YOUR TURN ─────────────────────────────────────\n'
      + '  // Write your code here.\n'
      + '  // ──────────────────────────────────────────────────\n'
      + '}\n',
    );
  });

  it('never invents indentation beyond what visible_pre actually trails with (no indent -> no indent)', () => {
    const scaffold = synthesizeScaffold('function f() {', '\n}');
    expect(scaffold.split('\n')[1]).toBe('// ── YOUR TURN ─────────────────────────────────────');
  });

  it('does not double a newline when visible_post already starts with one', () => {
    const scaffold = synthesizeScaffold('function f() {\n', '\n}');
    // No blank line between the marker's closing border and `}`.
    expect(scaffold).toBe(
      'function f() {\n'
      + '// ── YOUR TURN ─────────────────────────────────────\n'
      + '// Write your code here.\n'
      + '// ──────────────────────────────────────────────────\n'
      + '}',
    );
  });

  it('adds exactly one newline when visible_post has no leading one', () => {
    const scaffold = synthesizeScaffold('function f() {\n', '}');
    expect(scaffold.endsWith('──────\n}')).toBe(true);
  });

  it('only ever reads visible_pre/visible_post — never any answer text', () => {
    // synthesizeScaffold's signature has no reference_answer parameter at all; this test pins
    // that invariant at the type level (a call site literally cannot pass one in) and, for good
    // measure, confirms the marker's task line is always the same fixed fallback sentence rather
    // than anything derived from the artifact.
    const a = synthesizeScaffold('function f() {\n', '\n}');
    const b = synthesizeScaffold('function totallyDifferentName() {\n', '\n}');
    const markerLineA = a.split('\n').find((l) => l.includes('Write your code here.'));
    const markerLineB = b.split('\n').find((l) => l.includes('Write your code here.'));
    expect(markerLineA).toBe(markerLineB);
  });
});

describe('resolveScaffold', () => {
  const base = { visible_pre: 'function f() {\n', visible_post: '\n}' };

  it('returns rung.scaffold verbatim when present', () => {
    expect(resolveScaffold({ ...base, scaffold: 'literally anything' })).toBe('literally anything');
  });

  it('falls back to synthesizeScaffold when scaffold is absent', () => {
    expect(resolveScaffold({ ...base, scaffold: undefined })).toBe(synthesizeScaffold(base.visible_pre, base.visible_post));
  });
});

describe('findMarkerLineRange', () => {
  const doc = [
    'export async function consumeStream(response) {',
    '  // ── YOUR TURN ─────────────────────────────────────',
    '  // Implement the body of consumeStream.',
    '  // ──────────────────────────────────────────────────',
    '}',
    '',
    'function handleLine(line) { return true; }',
  ].join('\n');

  it('finds the marker\'s 3 lines (1-indexed, matching CM6\'s doc.line() convention)', () => {
    expect(findMarkerLineRange(doc)).toEqual({ startLine: 2, endLine: 4 });
  });

  it('returns null when there is no marker at all', () => {
    expect(findMarkerLineRange('function f() {\n  return 1;\n}')).toBeNull();
  });

  it('shrinks gracefully (never crashes, never "restores") when the learner deletes the closing border', () => {
    const partial = [
      'function f() {',
      '  // ── YOUR TURN ─────────────────────────────────────',
      '  // Implement the body.',
      '  return doWork();',
      '}',
    ].join('\n');
    expect(findMarkerLineRange(partial)).toEqual({ startLine: 2, endLine: 3 });
  });

  it('does not sweep in an unrelated comment the learner writes right after a properly-closed marker', () => {
    const withTrailingComment = [
      'function f() {',
      '  // ── YOUR TURN ─────────────────────────────────────',
      '  // Implement the body.',
      '  // ──────────────────────────────────────────────────',
      '  // unrelated note the learner left here',
      '  return doWork();',
      '}',
    ].join('\n');
    expect(findMarkerLineRange(withTrailingComment)).toEqual({ startLine: 2, endLine: 4 });
  });

  it('disappears entirely once the top border line itself is gone, even if other marker text lingers', () => {
    const noAnchor = [
      'function f() {',
      '  // Implement the body of consumeStream.',
      '  // ──────────────────────────────────────────────────',
      '  return doWork();',
      '}',
    ].join('\n');
    expect(findMarkerLineRange(noAnchor)).toBeNull();
  });
});
