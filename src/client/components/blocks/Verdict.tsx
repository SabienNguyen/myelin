/** The grading verdict on a done card, as a live region every block shares.
 *
 *  Rendered from SUBMIT time, empty until grading lands. The order matters: aria-live announces
 *  CHANGES to a region already in the tree, so the old per-block pattern — mount the <em> only
 *  once grading exists, text and all — was a brand-new live region born full, which most screen
 *  readers skip. Keeping the element mounted makes grading's arrival the announced change. Empty,
 *  it is an inline element with no border or padding, which lays out as a zero-height line box —
 *  the submitted card looks unchanged. */
export function Verdict({ grading, dash, word }: {
  grading?: { verdict: string; detail: string } | null;
  /** Prefix ' — ' for inline placements that continue a sentence. */
  dash?: boolean;
  /** Announce the one-word verdict instead of the detail (quick_check's card shows no detail). */
  word?: boolean;
}) {
  return (
    <em role="status" className={grading ? `verdict ${grading.verdict}` : 'verdict'}>
      {grading ? `${dash ? ' — ' : ''}${word ? grading.verdict : grading.detail}` : null}
    </em>
  );
}

/** ✓/✗ beside a graded item. The bare glyphs read as "check mark" / "ballot x" — or nothing —
 *  in a screen reader; this gives them the words the color already carries for sighted eyes. */
export function Mark({ ok }: { ok: boolean }) {
  return (
    <span className={ok ? 'mark-ok' : 'mark-bad'} role="img" aria-label={ok ? 'correct' : 'incorrect'}>
      {ok ? '✓' : '✗'}
    </span>
  );
}
