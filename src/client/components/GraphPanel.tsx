import { useEffect, useState } from 'react';
import { useThreadRuntime } from '@assistant-ui/react';
import { getArrow } from 'perfect-arrows';
import { getGraph } from '../lib/api.js';
import { layoutGraph, type LaidOutNode, type LaidOutEdge } from '../lib/graphLayout.js';
import { panelBus } from '../lib/panelBus.js';

const R = 16;
const PAD = 60;
const POLL_MS = 30_000;

// Tuned low so the layered (mostly-vertical) layout reads as refined arcs
// rather than the swoopy default perfect-arrows curves.
const PREREQ_ARROW_OPTS = { bow: 0.15, stretch: 0.3, padStart: R + 2, padEnd: R + 7 };

export function GraphPanel({ visible = true }: { visible?: boolean }) {
  const [nodes, setNodes] = useState<LaidOutNode[]>([]);
  const [edges, setEdges] = useState<LaidOutEdge[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const threadRuntime = useThreadRuntime();

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const load = async () => {
      const data = await getGraph();
      if (cancelled) return;
      const laid = layoutGraph(data.nodes ?? [], new Date());
      setNodes(laid.nodes);
      setEdges(laid.edges);
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [visible]);

  const byId = new Map(nodes.map((n) => [n.slug, n]));
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = (xs.length ? Math.min(...xs) : 0) - PAD;
  const minY = (ys.length ? Math.min(...ys) : 0) - PAD;
  const maxX = (xs.length ? Math.max(...xs) : 200) + PAD;
  const maxY = (ys.length ? Math.max(...ys) : 200) + PAD;
  const width = maxX - minX;
  const height = maxY - minY;

  return (
    <div className="graph-panel" style={{ overflow: 'auto', width: '100%', height: '100%' }}>
      <svg viewBox={`${minX} ${minY} ${width} ${height}`} width={width} height={height}>
        {edges.map((e) => {
          const src = byId.get(e.src);
          const dst = byId.get(e.dst);
          if (!src || !dst) return null;
          if (e.type === 'deepens') {
            // Dashed S-curve (curveBumpY-style): leave/enter nodes vertically, stop at the rim.
            const dir = dst.y > src.y ? 1 : -1;
            const y1 = src.y + dir * (R + 2);
            const y2 = dst.y - dir * (R + 7);
            const my = (y1 + y2) / 2;
            const d = `M ${src.x} ${y1} C ${src.x} ${my}, ${dst.x} ${my}, ${dst.x} ${y2}`;
            return (
              <path key={`deepens-${e.src}-${e.dst}`} d={d} fill="none"
                stroke="#888" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.5} />
            );
          }
          // Prereq edges: perfect-arrows tapered arc, padded to stop at each node's rim.
          const [sx, sy, cx, cy, ex, ey, ae] = getArrow(src.x, src.y, dst.x, dst.y, PREREQ_ARROW_OPTS);
          const endAngleDeg = ae * (180 / Math.PI);
          return (
            <g key={`prereq-${e.src}-${e.dst}`}>
              <path d={`M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`} fill="none" stroke="#888" strokeWidth={1.5} />
              <polygon points="0,-5 10,0 0,5" fill="#888"
                transform={`translate(${ex},${ey}) rotate(${endAngleDeg})`} />
            </g>
          );
        })}
        {nodes.map((n) => (
          <g key={n.slug} className="graph-node" transform={`translate(${n.x},${n.y})`}
            onClick={() => { setSelected(n.slug); panelBus.openPage(n.slug); }}
            style={{ cursor: 'pointer' }}>
            <title>{`${n.title} — ${n.effective}${n.daysLeft != null ? `, ${n.daysLeft}d until decay` : ''}`}</title>
            <circle r={R} fill={n.color} />
            {n.ringFraction != null && (
              <circle r={R + 4} fill="none" stroke={n.color} strokeWidth={2}
                pathLength={100} strokeDasharray={`${n.ringFraction * 100} 100`}
                transform="rotate(-90)" />
            )}
            {n.misconceptions.length > 0 && (
              <g>
                <title>{n.misconceptions.join('; ')}</title>
                <text x={R - 6} y={-R + 6} fontSize={12}>⚠</text>
              </g>
            )}
            <text y={R + 14} textAnchor="middle" fontSize={11}>
              {n.title}{n.daysLeft != null ? ` · ${n.daysLeft}d` : ''}
            </text>
            {selected === n.slug && (
              <foreignObject x={-45} y={R + 20} width={90} height={26}>
                <button
                  onClick={(ev) => { ev.stopPropagation(); threadRuntime.append(`Teach me ${n.slug} now`); }}
                >
                  Teach me this
                </button>
              </foreignObject>
            )}
          </g>
        ))}
      </svg>
      <div className="graph-legend">
        <span><i className="dot" style={{ background: '#9e9e9e' }} /> unseen</span>
        <span><i className="dot" style={{ background: '#e0b040' }} /> exposed</span>
        <span><i className="dot" style={{ background: '#5b8def' }} /> practicing</span>
        <span><i className="dot" style={{ background: '#4caf7d' }} /> mastered</span>
        <span><i className="ring" /> time till decay</span>
        <span>⚠ misconception</span>
      </div>
    </div>
  );
}
