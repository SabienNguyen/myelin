import { useEffect, useState } from 'react';
import { useThreadRuntime } from '@assistant-ui/react';
import { getGraph } from '../lib/api.js';
import { layoutGraph, type LaidOutNode, type LaidOutEdge } from '../lib/graphLayout.js';
import { panelBus } from '../lib/panelBus.js';

const R = 16;
const PAD = 60;
const POLL_MS = 30_000;

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
        <defs>
          <marker id="prereq-arrow" markerWidth={8} markerHeight={8} refX={7} refY={4} orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="#888" />
          </marker>
        </defs>
        {edges.map((e) => {
          const src = byId.get(e.src);
          const dst = byId.get(e.dst);
          if (!src || !dst) return null;
          return (
            <line key={`${e.type}-${e.src}-${e.dst}`} x1={src.x} y1={src.y} x2={dst.x} y2={dst.y}
              stroke="#888" strokeWidth={1.5}
              strokeDasharray={e.type === 'deepens' ? '4 3' : undefined}
              opacity={e.type === 'deepens' ? 0.5 : 1}
              markerEnd={e.type === 'prereq' ? 'url(#prereq-arrow)' : undefined} />
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
