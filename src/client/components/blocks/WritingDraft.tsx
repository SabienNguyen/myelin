import { useState } from 'react';
import { panelBus } from '../../lib/panelBus.js';
import { StagePortal } from '../StagePortal.js';

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
    return (
      <div className="block writing-draft done">
        <p>{args.prompt}</p>
        <p>
          {segments.map((seg, i) => seg.category
            ? <mark key={i} className={`ann-${seg.category}`} title={seg.note}>{seg.text}</mark>
            : <span key={i}>{seg.text}</span>)}
        </p>
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
      <p>{args.prompt}</p>
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
      <div className="block chip" onClick={() => panelBus.setTab('stage')}>✍️ Writing exercise sent to stage ▸</div>
      <StagePortal><WritingDraftInner args={props.args} result={undefined} addResult={props.addResult} /></StagePortal>
    </>
  );
}
