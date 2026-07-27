import { useEffect, useRef, useState } from 'react';

/**
 * Renders a ```mermaid fence from the tutor's prose as a real diagram.
 *
 * This is the smallest piece of the visual modality: several subjects are not primarily verbal
 * (circuits, anatomy, state machines, harmony), and until this existed the tutor could only ever
 * DESCRIBE structure in words. Now "sketch the phases of mitosis as a flowchart" renders.
 *
 * The library is dynamic-imported on first use: mermaid is megabytes of parser we should not make
 * every chat turn pay for, and most turns contain no diagram.
 *
 * Failures degrade to the SOURCE, labelled as such — a tutor-authored diagram with a syntax error
 * should read as "here is what it tried to draw", not vanish or take the message down with it.
 */
export function Mermaid({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        // securityLevel 'strict' is mermaid's own sanitizer: no script, no foreign HTML.
        // Theme follows the app's: 'neutral' renders white boxes, which glared out of a dark chat
        // in the audit screenshot.
        const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral' });
        const { svg: rendered } = await mermaid.render(idRef.current, chart);
        // Clear any earlier failure: while the tutor is STREAMING, this component sees the fence
        // grow chunk by chunk, and a half-written chart legitimately fails to parse. Without the
        // reset that failure latched — the completed chart rendered fine into `svg`, but the
        // fallback branch won and the finished message showed source forever (seen live on the
        // transformer-syllabus sitting; a reload of the same thread rendered the diagram).
        if (!cancelled) { setSvg(rendered); setFailed(false); }
      } catch {
        if (!cancelled) { setFailed(true); setSvg(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [chart]);

  if (failed) {
    return (
      <pre className="mermaid-fallback">
        <span className="mermaid-fallback-note">diagram did not render — its source:</span>
        {'\n'}{chart}
      </pre>
    );
  }
  if (!svg) return <div className="mermaid-loading" role="status">drawing…</div>;
  // Mermaid's output under securityLevel 'strict' has been through its sanitizer.
  // eslint-disable-next-line react/no-danger
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
