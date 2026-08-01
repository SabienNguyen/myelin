// A section whose header folds it away. The Library stacks progress, decay, review, paths, link
// directories and one block per book; a vault with a dozen books turns that into a scroll the
// learner has to hunt through to reach the part they came for. Same for a page's standing /
// prerequisites / edges. Folding is per-section and REMEMBERED, so the shape a learner arranges
// once survives reloads — a collapse that resets on every render is worse than none, because they
// pay the click and keep the scroll.
import { useCallback, useState } from 'react';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';

const KEY = 'myelin.collapsed';

/** The collapsed-section id set, read fresh from localStorage. Not cached in a module variable:
 *  two panels can mount the same id (a book row appears in Library and in search), and a stale
 *  copy would let one instance's toggle silently lose the other's. */
function collapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set(); // private-mode / quota / corrupt JSON — degrade to "everything open"
  }
}

function persist(next: Set<string>) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch { /* storage unavailable: the fold still works for this session, it just won't survive */ }
}

export function Collapsible({
  id, title, className, actions, level = 2, label, defaultOpen = true, children,
}: {
  /** Stable across renders and reloads — this is the localStorage key for the fold state. */
  id: string;
  title: React.ReactNode;
  className?: string;
  /** Heading level for the title. The toggle lives INSIDE a real heading (the WAI-ARIA accordion
   *  pattern) rather than replacing it: these titles are the document's outline, and a <span> in a
   *  button drops every one of them out of screen-reader heading navigation. */
  level?: 2 | 3 | 4;
  /** Accessible name for the landmark, when the visible title isn't the right one — a section
   *  whose heading is an icon plus a word still needs to announce as a named region. Defaults to
   *  the title when that is a plain string. */
  label?: string;
  /** Controls that belong to the header itself (a rename button, a count) and must stay reachable
   *  while the body is folded. Rendered OUTSIDE the toggle button — nesting a button in a button
   *  is invalid HTML and swallows the inner click. */
  actions?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => (collapsed().has(id) ? false : defaultOpen));
  const toggle = useCallback(() => {
    setOpen((was) => {
      const next = collapsed();
      if (was) next.add(id); else next.delete(id);
      persist(next);
      return !was;
    });
  }, [id]);

  const Heading = `h${level}` as 'h2' | 'h3' | 'h4';
  const name = label ?? (typeof title === 'string' ? title : undefined);

  return (
    <section
      className={`collapsible${open ? '' : ' is-collapsed'}${className ? ` ${className}` : ''}`}
      aria-label={name}
    >
      <div className="collapsible-head">
        <Heading className="collapsible-title">
          <button
            type="button"
            className="collapsible-toggle"
            aria-expanded={open}
            onClick={toggle}
          >
            <CaretRight size={13} weight="bold" className="collapsible-caret" aria-hidden />
            {title}
          </button>
        </Heading>
        {actions}
      </div>
      {/* Unmounted, not hidden: these bodies hold live queries and graph canvases, and keeping a
          dozen folded books mounted is the cost the fold was meant to remove. */}
      {open && <div className="collapsible-body">{children}</div>}
    </section>
  );
}
