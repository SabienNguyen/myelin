/** The grading verdict on a done card, as a live region every block shares.
 *
 *  Rendered from SUBMIT time, empty until grading lands. The order matters: aria-live announces
 *  CHANGES to a region already in the tree, so the old per-block pattern — mount the <em> only
 *  once grading exists, text and all — was a brand-new live region born full, which most screen
 *  readers skip. Keeping the element mounted makes grading's arrival the announced change. Empty,
 *  it is an inline element with no border or padding, which lays out as a zero-height line box —
 *  the submitted card looks unchanged.
 *
 *  It also names HOW the verdict was reached. The card is where the learner decides what they
 *  know, and until this prop existed a machine check and a model's opinion rendered identically
 *  there — the one distinction the whole evidence ceiling rests on (grading.ts capApplied), lost
 *  at the only moment it matters. */
export function Verdict({ grading, dash, word }: {
  grading?: { verdict: string; detail: string; source?: string } | null;
  /** Prefix ' — ' for inline placements that continue a sentence. */
  dash?: boolean;
  /** Announce the one-word verdict instead of the detail (quick_check's card shows no detail). */
  word?: boolean;
}) {
  // 'ungraded' is the grader itself failing (session.ts stamps source 'model' on a grader that
  // threw), so naming a source there would credit a judgement nobody made.
  const qualifier = grading && grading.verdict !== 'ungraded'
    ? SOURCE_QUALIFIER[grading.source ?? ''] : undefined;
  return (
    <em role="status" className={grading ? `verdict ${grading.verdict}` : 'verdict'}>
      {grading ? `${dash ? ' — ' : ''}${word ? grading.verdict : grading.detail}` : null}
      {qualifier !== undefined ? <span className="verdict-source"> · {qualifier}</span> : null}
    </em>
  );
}

/** Only the EXCEPTION is named, which is the convention Quiz.tsx already states beside its per-item
 *  chip: "Checked is the default and gets no badge; judged is the exception worth naming." Badging
 *  both put "· checked mechanically" on every ordinary card, and on a mixed quiz — whose block
 *  source is its WEAKEST item (grading.ts) — it put "· judged by the tutor" above a list where
 *  most rows carried no chip, contradicting the rows beneath it.
 *
 *  standingLine's words (PagePanel.tsx), not new ones: the learner meets this same distinction on
 *  the page panel, and two vocabularies for one fact read as two facts. An unknown or absent
 *  source stays silent — turns saved before the field existed must not claim either. */
const SOURCE_QUALIFIER: Record<string, string> = {
  model: 'judged by the tutor',
};

/** ✓/✗ beside a graded item. The bare glyphs read as "check mark" / "ballot x" — or nothing —
 *  in a screen reader; this gives them the words the color already carries for sighted eyes. */
export function Mark({ ok }: { ok: boolean }) {
  return (
    <span className={ok ? 'mark-ok' : 'mark-bad'} role="img" aria-label={ok ? 'correct' : 'incorrect'}>
      {ok ? '✓' : '✗'}
    </span>
  );
}
