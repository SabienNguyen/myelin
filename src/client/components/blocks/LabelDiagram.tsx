import { useMemo, useState } from 'react';
import { CheckIcon as Check, MapPinIcon as MapPin } from '@phosphor-icons/react';
import { BlockProse } from '../BlockProse.js';
import { StagePortal } from '../StagePortal.js';
import { panelBus } from '../../lib/panelBus.js';
import { Mark, Verdict } from './Verdict.js';

interface Region { id: string; x: number; y: number; label: string }
interface Args { prompt: string; pageSlug: string; svg: string; regions: Region[]; distractors?: string[] }

/** A live tutor delivered its whole SVG HTML-entity-escaped (`&lt;svg …`), which rendered as a
 * broken ~26px-tall image that crushed every pin into one unclickable band. When the string
 * plainly isn't markup but its escaped form is, decode the five XML entities — `&amp;` last so
 * double-escapes resolve in one pass. Already-valid SVG passes through untouched. */
export function decodeEntityEscapedSvg(svg: string): string {
  if (!svg.trimStart().startsWith('&lt;')) return svg;
  return svg
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

/** Minimum pin separation in canvas percent — a pin is ~30px on a ~550px canvas. */
const PIN_MIN_GAP = 6;

/** Model-supplied coordinates arrive with no spacing guarantee, and two coincident regions left
 * one pin buried under the other — visible, but never clickable, so the exercise could not be
 * completed by mouse (caught by a live sitting: region `embed` under region `ln2`). A greedy
 * deterministic pass nudges any colliding pin downward until it clears everything placed before
 * it; order is the regions array, so the same input always renders the same layout. */
export function separatePins(regions: Region[]): Region[] {
  const placed: Region[] = [];
  for (const r of regions) {
    let { x, y } = r;
    x = Math.min(97, Math.max(2, x));
    y = Math.min(97, Math.max(2, y));
    let moved = true;
    while (moved) {
      moved = false;
      for (const p of placed) {
        if (Math.hypot(p.x - x, p.y - y) < PIN_MIN_GAP) {
          y = y + PIN_MIN_GAP > 97 ? y - PIN_MIN_GAP : y + PIN_MIN_GAP;
          moved = true;
        }
      }
    }
    placed.push({ ...r, x, y });
  }
  return placed;
}

/**
 * Assign labels to regions of a diagram. Click a label, then click the pin it belongs on —
 * chosen over drag-and-drop deliberately: click-click works with a keyboard and a screen reader
 * and on a phone, and drag adds nothing pedagogical.
 *
 * The tutor's SVG is rendered through an <img> data URI, which makes it INERT — scripts never run
 * inside an image document, so a model-drawn diagram cannot touch the page it is embedded in.
 */
export function LabelDiagram({ args, result, addResult }: {
  args: Args; result: any; addResult: (r: any) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [placed, setPlaced] = useState<Record<string, string>>({});

  // Correct labels plus distractors, in an order that is stable across renders but not the answer
  // order. Sorting by a hash of the text is deterministic without Math.random-in-render churn.
  const tray = useMemo(() => {
    const all = [...args.regions.map((r) => r.label), ...(args.distractors ?? [])];
    const hash = (t: string) => [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    return [...new Set(all)].sort((a, b) => hash(a) - hash(b));
  }, [args.regions, args.distractors]);

  const src = `data:image/svg+xml;utf8,${encodeURIComponent(decodeEntityEscapedSvg(args.svg))}`;

  if (result) {
    const byId = new Map<string, boolean>(
      (result.grading?.perItem ?? []).map((p: any) => [p.id, p.correct]),
    );
    const placements = new Map<string, string>(
      (result.placements ?? []).map((p: any) => [p.regionId, p.label]),
    );
    return (
      <div className="block label-diagram done">
        <span className="graded-tag">{result.grading ? <><Check size={12} weight="bold" aria-hidden /> graded</> : 'submitted'}</span>
        <BlockProse text={args.prompt} />
        <ul className="label-diagram-summary">
          {args.regions.map((r) => {
            const got = placements.get(r.id);
            const ok = byId.get(r.id);
            return (
              <li key={r.id}>
                {got ?? '(left blank)'} {ok != null && <Mark ok={ok} />}
                {/* A miss shows what the region actually was — an ✗ alone tells the learner they
                    were wrong but not the anatomy. Same honesty as the pattern checker naming its
                    expected value. Only after grading, so it never pre-reveals the answer. */}
                {ok === false && <span className="label-correct">should be “{r.label}”</span>}
              </li>
            );
          })}
        </ul>
        <Verdict grading={result.grading} />
      </div>
    );
  }

  const assign = (regionId: string) => {
    if (selected) {
      setPlaced((p) => ({ ...p, [regionId]: selected }));
      setSelected(null);
    } else if (placed[regionId]) {
      // Clicking a labelled pin with nothing selected takes the label back.
      setPlaced((p) => {
        const { [regionId]: _drop, ...rest } = p;
        return rest;
      });
    }
  };
  // A label the DIAGRAM needs twice (two residual-add regions, say) must survive its first
  // placement — the tray dedupes labels into one chip, and a chip that died after one use made
  // duplicate-label diagrams impossible to complete (caught by a live sitting: the second
  // residual pin could never be filled and Submit stayed disabled forever). A chip exhausts when
  // placed as many times as regions carry its label; distractors exhaust after one placement.
  const neededCount = new Map<string, number>();
  for (const r of args.regions) neededCount.set(r.label, (neededCount.get(r.label) ?? 0) + 1);
  const placedCount = new Map<string, number>();
  for (const l of Object.values(placed)) placedCount.set(l, (placedCount.get(l) ?? 0) + 1);
  const exhausted = (label: string) =>
    (placedCount.get(label) ?? 0) >= Math.max(1, neededCount.get(label) ?? 0);
  const allPlaced = args.regions.every((r) => placed[r.id]);

  const inner = (
    <div className="block label-diagram">
      <h2><MapPin size={16} weight="duotone" /> Label the diagram</h2>
      <BlockProse text={args.prompt} />
      <div className="label-diagram-canvas">
        <img src={src} alt="diagram to label" draggable={false} />
        {separatePins(args.regions).map((r) => (
          <button
            key={r.id}
            type="button"
            className={`label-pin${placed[r.id] ? ' is-placed' : ''}${selected ? ' is-target' : ''}`}
            style={{ left: `${r.x}%`, top: `${r.y}%` }}
            onClick={() => assign(r.id)}
            aria-label={placed[r.id] ? `region ${r.id}: labelled ${placed[r.id]} — click to change` : `region ${r.id}: unlabelled`}
          >
            {placed[r.id] ?? '?'}
          </button>
        ))}
      </div>
      <div className="label-tray" role="group" aria-label="labels to place">
        {tray.map((label) => (
          <button
            key={label}
            type="button"
            className={`label-chip${selected === label ? ' is-selected' : ''}${exhausted(label) ? ' is-used' : ''}`}
            aria-pressed={selected === label}
            onClick={() => setSelected((s) => (s === label ? null : label))}
            disabled={exhausted(label)}
          >
            {label}
          </button>
        ))}
      </div>
      {/* role="status": picking a chip flips this line to "now click the pin…", which is the only
          confirmation the selection took — sighted users see the chip highlight, a screen reader
          needs the change spoken. */}
      <p className="label-diagram-hint" role="status">
        {selected ? `now click the pin where “${selected}” belongs` : 'pick a label, then click its pin'}
      </p>
      <button
        type="button"
        className="label-diagram-submit"
        disabled={!allPlaced}
        onClick={() => addResult({
          placements: Object.entries(placed).map(([regionId, label]) => ({ regionId, label })),
        })}
      >
        Submit
      </button>
    </div>
  );

  // Same chip-plus-portal pattern as Quiz/MathScratchpad: the chat keeps a small marker where the
  // block was called, and the interactive surface lives on the Stage.
  return (
    <>
      <button type="button" className="block chip" onClick={() => panelBus.setTab('stage')}>
        <MapPin size={15} weight="duotone" /> Diagram waiting on the stage
      </button>
      <StagePortal>{inner}</StagePortal>
    </>
  );
}
