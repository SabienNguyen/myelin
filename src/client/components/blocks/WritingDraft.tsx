import { useState } from 'react';
import { PenNibIcon as PenNib } from '@phosphor-icons/react';
import { panelBus } from '../../lib/panelBus.js';
import { StagePortal } from '../StagePortal.js';
import { BlockProse } from '../BlockProse.js';

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

  if (result) {
    const grading = result.grading;
    const annotations: Annotation[] = grading?.annotations?.annotations ?? [];
    const segments = annotateDraft(result.draft, annotations);
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
          <ul className="rubric-results">
            {grading.rubric.map((r: any) => (
              <li key={r.criterion} className={r.pass ? 'rubric-pass' : 'rubric-fail'}>
                <span className={r.pass ? 'mark-ok' : 'mark-bad'}>{r.pass ? '✓' : '✗'}</span>{' '}
                {r.criterion}
                {r.note && <em> — {r.note}</em>}
              </li>
            ))}
          </ul>
        )}
        {grading?.annotations?.skillGrades && (
          <ul className="skill-grades">
            {Object.entries(grading.annotations.skillGrades).map(([skill, grade]) => (
              <li key={skill}>{skill}: {String(grade)}</li>
            ))}
          </ul>
        )}
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
      <button onClick={() => addResult({ draft })}>Submit</button>
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
