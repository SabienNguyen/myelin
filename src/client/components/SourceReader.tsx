// The source reader: the human artifact as the LIVING SURFACE.
//
// The librarian principle (tutor prompt rule 13) says learning routes THROUGH human artifacts —
// so the artifact cannot stay a thing the app only compiles and files away. This panel renders
// the raw ingested source, and selecting any passage offers one action: take it to the tutor.
// The quoted passage becomes the message, the tutor grounds its answer in it, and the reader
// stays open beside the conversation — reading and querying are one surface, not two apps.

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeftIcon as ArrowLeft } from '@phosphor-icons/react';
import { useThreadRuntime } from '@assistant-ui/react';

/** Selection cap: a "passage" is a sentence or a paragraph, not three pages. Beyond this the
 *  quote would drown the thread and the model's attention alike. */
const MAX_PASSAGE = 600;

export function SourceReader({ path, title, onClose }: {
  path: string; title: string; onClose: () => void;
}) {
  const threadRuntime = useThreadRuntime();
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ text: string; x: number; y: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/source?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.markdown != null) setMarkdown(String(d.markdown).replace(/^<!--[\s\S]*?-->\s*/, ''));
        else setError(d.error ?? 'could not load the source');
      })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [path]);

  // Selection -> a floating "ask" affordance near the pointer. Recomputed on every mouseup in
  // the body; cleared when the selection collapses or the passage is sent.
  const onMouseUp = (e: React.MouseEvent) => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (!text || !bodyRef.current?.contains(sel!.anchorNode)) { setAsk(null); return; }
    const rect = bodyRef.current.getBoundingClientRect();
    setAsk({
      text: text.length > MAX_PASSAGE ? `${text.slice(0, MAX_PASSAGE)}…` : text,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  const sendPassage = () => {
    if (!ask) return;
    threadRuntime.append(`From the source “${title}”:\n\n> ${ask.text.replace(/\n/g, '\n> ')}\n\nWalk me through this passage.`);
    setAsk(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div className="source-reader">
      <div className="source-reader-bar">
        {/* One way out, back to the compiled-page view — the reader is a mode of the Page tab,
            not a fifth tab. */}
        <button type="button" className="ghost-btn" onClick={onClose}>
          <ArrowLeft size={14} /> back
        </button>
        <span className="source-reader-title">{title}</span>
        <span className="source-reader-hint">select any passage to ask the tutor about it</span>
      </div>
      {error && <p className="source-reader-error">{error}</p>}
      {markdown === null && !error && <p className="source-reader-loading">opening the source…</p>}
      {markdown !== null && (
        <div className="source-reader-body" ref={bodyRef} onMouseUp={onMouseUp}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
          {ask && (
            <button
              type="button"
              className="source-ask"
              style={{ left: ask.x, top: ask.y + 12 }}
              onClick={sendPassage}
            >
              Ask the tutor about this
            </button>
          )}
        </div>
      )}
    </div>
  );
}
