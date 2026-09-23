// Jump anywhere: Ctrl/Cmd+K (or the topbar's search button) opens one box over notebooks,
// conversations and pages, the way Linear and Raycast put navigation behind a keystroke. It only
// NAVIGATES — every result is a hash the app already understands — so it adds a way in, never a
// second way to do something.
import { useEffect, useMemo, useRef, useState } from 'react';
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { getGraph, getNotebooks } from '../lib/api.js';
import { notebookHash, parseHash, serializeHash } from '../lib/urlState.js';

export type PaletteKind = 'action' | 'notebook' | 'conversation' | 'page';
export interface PaletteItem { kind: PaletteKind; key: string; label: string; detail: string; href: string }

const GROUP_LABEL: Record<PaletteKind, string> = {
  action: 'Actions', notebook: 'Notebooks', conversation: 'Conversations', page: 'Pages',
};
// Actions rank last among equals: typing "no" should find the notebook before "Go to notebooks".
const KINDS: PaletteKind[] = ['notebook', 'conversation', 'page', 'action'];
const PER_GROUP = 6;

/** Match quality of `query` against `label`: 3 prefix, 2 word start, 1 anywhere, 0 in order with
 *  gaps ("chrl" finds "chain rule"), -1 no match. */
function score(label: string, query: string): number {
  const l = label.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  if (l.startsWith(q)) return 3;
  if (l.includes(` ${q}`)) return 2;
  if (l.includes(q)) return 1;
  let i = 0;
  for (const ch of l) if (ch === q[i]) i += 1;
  return i === q.length ? 0 : -1;
}

/** Filters and orders the items per group, best match first, keeping each group's own order
 *  among equals (notebooks by recent activity, conversations by recency). Groups themselves are
 *  ordered by their best match, so "ch" leads with the page "Chain rule" rather than the notebook
 *  "Organic chemistry" just because notebooks usually come first; ties keep the fixed order. Pure. */
export function rankItems(items: PaletteItem[], query: string): PaletteItem[] {
  const groups = KINDS.map((kind, rank) => {
    const hits = items
      .map((item, order) => ({ item, order, s: score(item.label, query) }))
      .filter((h) => h.item.kind === kind && h.s >= 0)
      .sort((a, b) => b.s - a.s || a.order - b.order)
      .slice(0, PER_GROUP);
    return { rank, best: hits[0]?.s ?? -1, items: hits.map((h) => h.item) };
  });
  return groups.sort((a, b) => b.best - a.best || a.rank - b.rank).flatMap((g) => g.items);
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

async function loadItems(): Promise<PaletteItem[]> {
  const here = parseHash(location.hash).threadId;
  // Each source is optional: a palette with no pages (graph down) still finds notebooks.
  const [notebooks, threads, graph] = await Promise.all([
    getNotebooks().catch((e) => { console.error('[palette] notebooks:', e); return null; }),
    fetch('/api/threads').then((r) => (r.ok ? r.json() : [])).catch((e) => { console.error('[palette] threads:', e); return []; }),
    getGraph().catch((e) => { console.error('[palette] graph:', e); return null; }),
  ]);
  // The app's few verbs, as Raycast lists commands beside places. Each is still just a hash.
  const items: PaletteItem[] = [
    { kind: 'action', key: 'a:notebooks', label: 'Go to notebooks', detail: '', href: notebookHash() },
    {
      kind: 'action', key: 'a:new', label: 'New conversation', detail: '',
      href: serializeHash({ threadId: `t-${Date.now().toString(36)}`, tab: 'stage', pageSlug: null }),
    },
    { kind: 'action', key: 'a:graph', label: 'Open the graph', detail: '', href: serializeHash({ threadId: here, tab: 'graph', pageSlug: null }) },
    { kind: 'action', key: 'a:library', label: 'Open the library', detail: 'progress, reviews, sources', href: serializeHash({ threadId: here, tab: 'library', pageSlug: null }) },
  ];
  for (const nb of notebooks?.notebooks ?? []) {
    items.push({
      kind: 'notebook', key: `n:${nb.id}`, label: nb.title, href: notebookHash(nb.id),
      detail: nb.due > 0 ? `${plural(nb.due, 'review')} due` : plural(nb.topics, 'topic'),
    });
  }
  for (const t of Array.isArray(threads) ? threads : []) {
    if (!t?.id || !(t.messages > 0)) continue;
    items.push({
      kind: 'conversation', key: `t:${t.id}`, label: String(t.title), detail: t.notebook?.title ?? '',
      href: serializeHash({ threadId: t.id, tab: 'stage', pageSlug: null }),
    });
  }
  for (const n of (graph?.nodes ?? []) as any[]) {
    if (!n?.slug || n.status === 'stub') continue;
    const level = n.mastery?.effective;
    items.push({
      kind: 'page', key: `p:${n.slug}`, label: typeof n.title === 'string' ? n.title : n.slug,
      detail: level && level !== 'unseen' ? level : '',
      // A page opens in the conversation you are in, where the Page tab can show it.
      href: serializeHash({ threadId: here, tab: 'page', pageSlug: n.slug }),
    });
  }
  return items;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PaletteItem[] | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setItems(null);
    inputRef.current?.focus();
    let cancelled = false;
    loadItems().then((i) => { if (!cancelled) setItems(i); });
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => { cancelled = true; document.removeEventListener('mousedown', onDown); };
  }, [open]);

  const results = useMemo(() => (items ? rankItems(items, query) : []), [items, query]);
  useEffect(() => { setActive(0); }, [query]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }
  function go(item: PaletteItem | undefined) {
    if (!item) return;
    setOpen(false);
    location.hash = item.href;
  }
  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
  }

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const optionId = (i: number) => `palette-opt-${i}`;

  return (
    <div className="palette" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ghost-btn palette-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
        onClick={() => setOpen((o) => !o)}
      >
        <MagnifyingGlass size={16} weight="bold" aria-hidden="true" />
        <span className="palette-trigger-label">Search</span>
        <kbd className="palette-kbd" aria-hidden="true">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      {open && (
        <div className="palette-panel" role="dialog" aria-label="Go to">
          <input
            ref={inputRef}
            className="palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={results.length ? optionId(active) : undefined}
            aria-label="Go to a notebook, conversation or page"
            placeholder="Go to a notebook, conversation or page…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
          />
          {items === null && <p className="palette-empty" role="status">loading…</p>}
          {items !== null && results.length === 0 && (
            <p className="palette-empty" role="status">Nothing matches “{query}”.</p>
          )}
          <ul id="palette-list" role="listbox" aria-label="Results" className="palette-list">
            {results.map((item, i) => (
              <li
                key={item.key}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className={`palette-option${i === active ? ' active' : ''}`}
                // mousedown, not click: the input keeps focus, so arrow keys keep working after a
                // hover, and the outside-click handler never sees it.
                onMouseDown={(e) => { e.preventDefault(); go(item); }}
                onMouseMove={() => setActive(i)}
              >
                {(i === 0 || results[i - 1].kind !== item.kind) && (
                  <span className="palette-group" aria-hidden="true">{GROUP_LABEL[item.kind]}</span>
                )}
                <span className="palette-row">
                  <span className="palette-label">{item.label}</span>
                  {item.detail && <span className="palette-detail">{item.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
