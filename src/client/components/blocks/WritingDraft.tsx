import { useEffect, useState } from 'react';
import { useThreadRuntime } from '@assistant-ui/react';
import { PenNibIcon as PenNib } from '@phosphor-icons/react';
import { panelBus } from '../../lib/panelBus.js';
import { StagePortal } from '../StagePortal.js';
import { BlockProse } from '../BlockProse.js';
import { Mark, Verdict } from './Verdict.js';
import { lintDraft, type DraftLint } from '../../lib/harperLinter.js';

/** The live grammar/style review under the draft — Harper's mechanical lints (harperLinter.ts),
 *  each located and with a one-click fix. This is the part of writing feedback that is a definite
 *  error, not a judgment: the model still weighs argument and structure, but "their/there" and
 *  subject–verb disagreement are caught here, deterministically, the way every other subject's
 *  mechanics are graded by machine. */
export function HarperReview({ lints, onApply }: { lints: DraftLint[]; onApply: (l: DraftLint) => void }) {
  if (lints.length === 0) return null;
  return (
    <div className="harper-review">
      <p className="harper-count">
        {lints.length} grammar &amp; style {lints.length === 1 ? 'issue' : 'issues'} — checked mechanically
      </p>
      <ul className="harper-lints">
        {lints.map((l, i) => (
          <li key={`${l.start}-${l.end}-${i}`} className="harper-lint">
            <span className={`harper-kind kind-${l.kind.toLowerCase().replace(/\W+/g, '-')}`}>{l.kind}</span>
            <span className="harper-message">
              {l.message}
              {l.problem && <> — <span className="harper-problem">“{l.problem}”</span></>}
            </span>
            {l.suggestion != null && (
              <button type="button" className="harper-apply" onClick={() => onApply(l)}>
                fix{l.suggestion ? <>: “{l.suggestion}”</> : ''}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

type Annotation = { span: string; category: string; note: string };
type Segment = { text: string; category?: string; note?: string };

// Walk the draft string, splitting on each annotation's exact `span` substring — first occurrence wins.
function annotateDraft(draft: string, annotations: Annotation[]): Segment[] {
  let segments: Segment[] = [{ text: draft }];
  for (const ann of annotations) {
    const next: Segment[] = [];
    let placed = false;
    for (const seg of segments) {
      if (!placed && !seg.category) {
        const idx = seg.text.indexOf(ann.span);
        if (idx >= 0) {
          if (idx > 0) next.push({ text: seg.text.slice(0, idx) });
          next.push({ text: ann.span, category: ann.category, note: ann.note });
          const rest = seg.text.slice(idx + ann.span.length);
          if (rest) next.push({ text: rest });
          placed = true;
          continue;
        }
      }
      next.push(seg);
    }
    segments = next;
  }
  return segments;
}

export function WritingDraftInner({ args, result, addResult }: {
  args: any; result: any; addResult: (r: any) => void;
}) {
  const [draft, setDraft] = useState(args.priorDraft ?? '');
  const [lints, setLints] = useState<DraftLint[]>([]);
  const threadRuntime = useThreadRuntime();

  // Live Harper linting while the learner writes, debounced so the WASM runs on a pause, not a
  // keystroke. Only in the writing view (no result yet). A cancelled flag drops a stale async
  // result if the draft moved on before it returned.
  useEffect(() => {
    if (result) return;
    let cancelled = false;
    const t = setTimeout(() => { void lintDraft(draft).then((ls) => { if (!cancelled) setLints(ls); }); }, 600);
    return () => { cancelled = true; clearTimeout(t); };
  }, [draft, result]);

  // Apply a suggestion by splicing it over the located span; the debounced effect re-lints the new
  // text, so offsets stay honest without hand-tracking them.
  const applyLint = (l: DraftLint) => {
    if (l.suggestion == null) return;
    setDraft((d: string) => d.slice(0, l.start) + l.suggestion + d.slice(l.end));
  };
  // A rubric note that QUOTES the draft can point at its evidence: clicking the quote adds an
  // ephemeral 'cite' annotation over the quoted text, so the criterion and the passage that
  // earned it light up together. Toggles off on a second click; never stored.
  const [cite, setCite] = useState<string | null>(null);

  if (result) {
    const grading = result.grading;
    const annotations: Annotation[] = grading?.annotations?.annotations ?? [];
    // (?? ''): a server-rejected tool call reaches here with a non-contract output, and
    // undefined.indexOf inside annotateDraft unmounted the app root (see Quiz for the incident).
    const withCite = cite && (result.draft ?? '').includes(cite)
      ? [{ span: cite, category: 'cite', note: 'quoted by a rubric note' }, ...annotations]
      : annotations;
    const segments = annotateDraft(result.draft ?? '', withCite);
    // Tufte-style footnotes: each annotated span gets a superscript number after the mark
    // (outside it — tests match the mark's exact text), with the grader's notes listed below.
    let n = 0;
    const notes: { n: number; category: string; note: string }[] = [];
    return (
      <div className="block writing-draft done">
        <BlockProse text={args.prompt} />
        <p className="draft-text">
          {segments.map((seg, i) => {
            if (!seg.category) return <span key={i}>{seg.text}</span>;
            if (seg.category === 'cite') return <mark key={i} className="ann-cite">{seg.text}</mark>;
            n += 1;
            notes.push({ n, category: seg.category, note: seg.note ?? '' });
            return (
              <span key={i}>
                <mark className={`ann-${seg.category}`} title={seg.note}>{seg.text}</mark>
                <sup className="fn-ref">{n}</sup>
              </span>
            );
          })}
        </p>
        {notes.length > 0 && (
          <ol className="footnotes">
            {notes.map((f) => (
              <li key={f.n} value={f.n}><span className={`fn-cat ann-${f.category}`}>{f.category}</span> {f.note}</li>
            ))}
          </ol>
        )}
        {grading?.rubric && (
          <>
            {/* Same label as the pre-writing card, so the verdict visibly answers the contract —
                without it the ✓/✗ list ran straight on from the footnotes as one more marginalia. */}
            <p className="rubric-upfront-title rubric-results-title">Judged against:</p>
            <ul className="rubric-results">
            {grading.rubric.map((r: any) => (
              <li key={r.criterion} className={r.pass ? 'rubric-pass' : 'rubric-fail'}>
                <Mark ok={r.pass} />{' '}
                {r.criterion}
                {r.note && (() => {
                  // "…" fragments in the note that appear verbatim in the draft link back to it —
                  // the grader is told to quote where possible, and a quote that can be POINTED
                  // AT beats one the learner has to hunt for.
                  const q = String(r.note).match(/[\u201c"']([^\u201c\u201d"']{4,120})[\u201d"']/);
                  const quoted = q && (result.draft ?? '').includes(q[1]) ? q[1] : null;
                  if (!quoted) return <em> — {r.note}</em>;
                  const [pre, post] = String(r.note).split(q![0]);
                  return (
                    <em> — {pre}
                      <button
                        type="button"
                        // `lit`, not the house `on`: `.block button.on` is the selected-answer
                        // pill (accent background), and this toggle is an underline change on an
                        // inline quote — the shared class dressed it as a chip.
                        className={`cite-link${cite === quoted ? ' lit' : ''}`}
                        aria-pressed={cite === quoted}
                        title="highlight this passage in the draft"
                        onClick={() => setCite((c) => (c === quoted ? null : quoted))}
                      >“{quoted}”</button>
                      {post}
                    </em>
                  );
                })()}
              </li>
            ))}
            </ul>
          </>
        )}
        {/* A failed criterion is an OPEN loop, and the card should offer to close it: one click
            asks the tutor for a revision round. The tutor reissues writing_draft with round+1,
            the SAME rubric, and priorDraft carrying this text (prompt rule 11b) — so the learner
            edits their own words against the same contract instead of retyping from memory. */}
        {grading?.rubric?.some((r: any) => !r.pass) && (
          <button
            type="button"
            className="revise-btn"
            onClick={() => threadRuntime.append(
              `Set me up to revise this draft — round ${(args.round ?? 1) + 1}, same rubric, starting from what I wrote.`,
            )}
          >
            Revise this draft
          </button>
        )}
        {grading?.annotations?.skillGrades && (
          <ul className="skill-grades">
            {Object.entries(grading.annotations.skillGrades).map(([skill, grade]) => (
              <li key={skill}>{skill}: {String(grade)}</li>
            ))}
          </ul>
        )}
        {/* The only done card that never showed grading.detail ("rubric: 2/3 criteria met") — the
            rubric list implied it. Shown now for the same reason every block gained this element:
            it is the live region that announces grading's arrival to a screen reader. */}
        <Verdict grading={grading} />
      </div>
    );
  }

  return (
    <div className="block writing-draft">
      <BlockProse text={args.prompt} />
      {/* The criteria the draft will be judged against, VISIBLE BEFORE WRITING. The whole design of
          rubric-passed says "criteria the learner could read in advance" — and the audit screenshot
          showed a tutor saying "the rubric is right there" above a block that never rendered it.
          Being judged against criteria you never saw is the thing a rubric exists to prevent. */}
      {Array.isArray(args.rubric) && args.rubric.length > 0 && (
        <div className="rubric-upfront">
          <p className="rubric-upfront-title">Judged against:</p>
          <ul>
            {args.rubric.map((r: string) => <li key={r}>{r}</li>)}
          </ul>
        </div>
      )}
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
      <HarperReview lints={lints} onApply={applyLint} />
      {/* The mechanical-issue count rides into the result so grading can weigh the draft's mechanics
          on a machine signal, not the model's read of them. */}
      <button onClick={() => addResult({ draft, mechanicalIssues: lints.length })}>Submit</button>
    </div>
  );
}

export function WritingDraft(props: { args: any; result: any; addResult: (r: any) => void }) {
  if (props.result) {
    return <WritingDraftInner args={props.args} result={props.result} addResult={props.addResult} />;
  }
  return (
    <>
      <button type="button" className="block chip" onClick={() => panelBus.setTab('stage')}><PenNib size={15} weight="duotone" /> Writing exercise waiting on the stage</button>
      <StagePortal><WritingDraftInner args={props.args} result={undefined} addResult={props.addResult} /></StagePortal>
    </>
  );
}
