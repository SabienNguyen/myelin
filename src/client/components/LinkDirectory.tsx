// Link directories: the browsable catalogue a repo ingest writes when a doc file turns out to be
// an awesome-list-shaped directory of external links (server: linkList.ts). Compiling such a file
// produced pages that were just themed tables of contents; the catalogue instead puts each link one
// click from the SAME single-document ingest the Add-material door uses — a video URL becomes a
// transcript paper, an article a compiled page. Ingesting stays a per-link choice: a directory can
// carry hundreds of links, and hours of unasked-for conversion is not a favor.
import { useEffect, useRef, useState } from 'react';

export interface DirectoryLink { title: string; url: string; note?: string }
export interface DirectorySection { title: string; links: DirectoryLink[] }
export interface LinkDirectoryEntry {
  name: string; source: string; file: string; savedAt: string;
  sections: DirectorySection[]; total: number; omitted: number;
}

const POLL_MS = 10_000;

function LinkRow({ link, added, onAdd }: { link: DirectoryLink; added: boolean; onAdd: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <li className="ld-link">
      <div className="ld-link-main">
        {/* The title opens the resource itself — reading it in a browser tab is a legitimate end;
            ingesting it into the vault is the second, separate verb. */}
        <a href={link.url} target="_blank" rel="noreferrer">{link.title}</a>
        {link.note && <span className="ld-note">{link.note}</span>}
      </div>
      {added
        ? <span className="ld-added">added</span>
        : (
          <button
            type="button"
            className="ghost-btn ld-add"
            disabled={busy}
            aria-label={`add ${link.title} to the library`}
            onClick={async () => {
              setBusy(true);
              setFailed(null);
              try {
                await onAdd();
              } catch (e: any) {
                setFailed(e?.message ?? String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'adding…' : 'add'}
          </button>
        )}
      {failed && <span className="ld-error" role="status">add failed: {failed}</span>}
    </li>
  );
}

/**
 * Renders every stored link directory, or nothing when there are none — safe to mount in both
 * Library branches. `queuedUrls` comes from the ledger the panel already polls (each URL ingest's
 * sourceUrl), so a link the learner added — this session or any before — shows as such.
 */
export function LinkDirectory({ visible = true, queuedUrls }: { visible?: boolean; queuedUrls: Set<string> }) {
  const [dirs, setDirs] = useState<LinkDirectoryEntry[]>([]);
  // URLs added THIS session, before the queue poll catches up — optimistic, merged with queuedUrls.
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const load = () => fetch('/api/linklists')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { if (!cancelled && Array.isArray(d)) { loadedRef.current = true; setDirs(d); } })
      .catch(() => {});
    load();
    const id = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [visible]);

  if (dirs.length === 0) return null;

  async function addLink(url: string) {
    const res = await fetch('/api/ingest', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? res.statusText);
    }
    setJustAdded((prev) => new Set(prev).add(url));
  }

  return (
    <>
      {dirs.map((dir) => (
        <section key={dir.name} className="library-book link-directory">
          <h2>{dir.name}</h2>
          <p className="ld-meta">
            link directory — {dir.total} links from {dir.file}
            {dir.omitted > 0 ? ` (${dir.omitted} more past the cap)` : ''} — add one to compile it into a page
            <button
              type="button"
              className="q-dismiss ld-dismiss"
              aria-label={`dismiss the ${dir.name} link directory`}
              onClick={async () => {
                await fetch('/api/linklists', {
                  method: 'DELETE',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ name: dir.name }),
                }).catch(() => {});
                setDirs((prev) => prev.filter((d) => d.name !== dir.name));
              }}
            >✕</button>
          </p>
          {dir.sections.map((s) => (
            <details key={s.title} className="ld-section">
              <summary>{s.title} ({s.links.length})</summary>
              <ul>
                {s.links.map((l) => (
                  <LinkRow
                    key={l.url}
                    link={l}
                    added={queuedUrls.has(l.url) || justAdded.has(l.url)}
                    onAdd={() => addLink(l.url)}
                  />
                ))}
              </ul>
            </details>
          ))}
        </section>
      ))}
    </>
  );
}
