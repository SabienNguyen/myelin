import { useMemo, useState } from 'react';
import { CheckIcon as Check, MapPinIcon as MapPin } from '@phosphor-icons/react';
import { BlockProse } from '../BlockProse.js';
import { StagePortal } from '../StagePortal.js';
import { panelBus } from '../../lib/panelBus.js';

interface Region { id: string; x: number; y: number; label: string }
interface Args { prompt: string; pageSlug: string; svg: string; regions: Region[]; distractors?: string[] }

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

  const src = `data:image/svg+xml;utf8,${encodeURIComponent(args.svg)}`;

  if (result) {
    const byId = new Map<string, boolean>(
      (result.grading?.perItem ?? []).map((p: any) => [p.id, p.correct]),
    );
    const placements = new Map<string, string>(
      (result.placements ?? []).map((p: any) => [p.regionId, p.label]),
    );
    return (
      <div className="block label-diagram done">
        <span className="graded-tag"><Check size={12} weight="bold" /> graded</span>
        <BlockProse text={args.prompt} />
        <ul className="label-diagram-summary">
          {args.regions.map((r) => {
            const got = placements.get(r.id);
            const ok = byId.get(r.id);
            return (
              <li key={r.id}>
                {got ?? '(left blank)'} {ok != null && (
                  <span className={ok ? 'mark-ok' : 'mark-bad'}>{ok ? '✓' : '✗'}</span>
                )}
              </li>
            );
          })}
        </ul>
        {result.grading && <em className={`verdict ${result.grading.verdict}`}>{result.grading.detail}</em>}
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
  const used = new Set(Object.values(placed));
  const allPlaced = args.regions.every((r) => placed[r.id]);

  const inner = (
    <div className="block label-diagram">
      <h3><MapPin size={16} weight="duotone" /> Label the diagram</h3>
      <BlockProse text={args.prompt} />
      <div className="label-diagram-canvas">
        <img src={src} alt="diagram to label" draggable={false} />
        {args.regions.map((r) => (
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
            className={`label-chip${selected === label ? ' is-selected' : ''}${used.has(label) ? ' is-used' : ''}`}
            onClick={() => setSelected((s) => (s === label ? null : label))}
            disabled={used.has(label)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="label-diagram-hint">
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
