import { panelBus, scrubModelArtifacts } from '../lib/panelBus.js';
import { usePageTitle } from '../lib/pageTitles.js';

// Fallback UI for MCP (server-side) tool calls in the transcript. The learner should see a
// quiet status line — "✓ evidence recorded" — never raw JSON args, retries, or tool plumbing.
//
// Each entry is [done, failed]. The failed column exists because the audit caught the chip
// rendering "✗ evidence recorded" for a call that FAILED — success copy under a failure mark,
// in the one app that must never misreport whether progress was saved.
const LABELS: Record<string, [string, string]> = {
  record_evidence: ['evidence recorded', 'evidence not recorded'],
  get_student_state: ['checked your progress', 'could not check your progress'],
  next_lessons: ['picked next lessons', 'could not pick next lessons'],
  find_analogies: ['looked for analogies', 'analogy search failed'],
  read_page: ['read a page', 'could not read the page'],
  search: ['searched the vault', 'vault search failed'],
  list_paths: ['checked paths', 'could not check paths'],
  read_path: ['read a path', 'could not read the path'],
  write_page: ['wrote a page', 'the page did not save'],
  link_pages: ['linked pages', 'could not link pages'],
  compile_source: ['compiled a source', 'compile failed'],
  create_path: ['created a path', 'the path did not save'],
  course_problems: ['fetched course problems', 'could not fetch course problems'],
  mark_course_problem: ['marked a course problem', 'could not mark the problem'],
  find_recent_papers: ['searched recent papers', 'paper search failed'],
  find_canonical_sources: ['searched canonical sources', 'source search failed'],
  ingest_paper: ['ingested a paper', 'ingest failed'],
  generate_exercise: ['generated an exercise', 'could not generate an exercise'],
  // ai-sdk route and Agent SDK spell their web tools differently; the learner sees one label.
  web_search: ['searched the web', 'web search failed'],
  read_url: ['read a web page', 'could not read the page'],
  WebSearch: ['searched the web', 'web search failed'],
  WebFetch: ['read a web page', 'could not read the page'],
};

// Tools that act on ONE page, and the verb their chip leads with. "read a page" twice in a row
// told the learner nothing about which pages the answer drew on; naming them, as a link into the
// Page tab, turns the marginalia into the answer's source list — what Perplexity and NotebookLM
// show under a reply.
const PAGE_VERBS: Record<string, string> = {
  read_page: 'read',
  write_page: 'wrote',
  record_evidence: 'evidence recorded on',
};

// A call still running — or one the learner stopped, whose outcome the server never reported.
// Done copy here claimed "evidence recorded" for a record_evidence nobody saw land.
const PENDING: Record<string, string> = {
  record_evidence: 'recording evidence…',
  read_page: 'reading a page…',
  write_page: 'writing a page…',
  search: 'searching the vault…',
  web_search: 'searching the web…',
  read_url: 'reading a web page…',
};

/** read_page's title from the MCP result as it arrives ({content:[{type:'text', text:<JSON>}]}). */
function readTitle(result: any): unknown {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text)?.page?.meta?.title;
  } catch {
    return undefined; // not JSON (an engram error string) — the slug stands in
  }
}

/** The title the call itself carries: read_page's result, or write_page's input. */
function carriedTitle(args: any, result: any): string | undefined {
  const title = readTitle(result) ?? args?.title;
  return typeof title === 'string' && title.trim() ? title : undefined;
}

/** The carried title, else the graph's title for that slug (record_evidence carries none), else
 *  the slug with its hyphens read as spaces — still recognisable, never invented. Titles are model
 *  or vault text, so they are scrubbed of leaked ChatML tokens like any other model output. */
function pageLabel(title: string | undefined, slug: string): string {
  const clean = title ? scrubModelArtifacts(title).trim() : '';
  return clean || slug.replace(/-/g, ' ');
}

export function ToolStatusChip({ toolName, args, result, isError }: any) {
  // Two shapes of failure: a tool that threw reaches here as the isError prop with `{ error }` as
  // its result (runtimeAdapter.ts), an MCP error as a result carrying isError. Either one must
  // never render as success — least of all as a link to the page it failed to touch.
  const failed = isError === true || (result && typeof result === 'object' && (result as any).isError === true);
  const [done, notDone] = LABELS[toolName] ?? [toolName, `${toolName} failed`];
  const slug = typeof args?.slug === 'string' && args.slug ? args.slug : null;
  const verb = PAGE_VERBS[toolName];
  const carried = carriedTitle(args, result);
  // Asked only when the call carries no title of its own, and called before the early returns
  // below: React needs the same hooks in the same order on every render, and a pending call turns
  // into a finished one on the next render.
  const graphTitle = usePageTitle(verb && slug && !carried ? slug : null);
  if (result === undefined && !failed) {
    return <span className="tool-note" title={toolName}>{PENDING[toolName] ?? 'working…'}</span>;
  }
  if (!failed && verb && slug) {
    return (
      <span className="tool-note" title={toolName}>
        {verb}{' '}
        <button type="button" className="tool-note-page" onClick={() => panelBus.openPage(slug)}>
          {pageLabel(carried ?? graphTitle, slug)}
        </button>
      </span>
    );
  }
  // Deliberately typographic, not a pill — reads as quiet marginalia, not UI chrome.
  return (
    <span className={`tool-note${failed ? ' failed' : ''}`} title={toolName}>
      {failed ? `✗ ${notDone}` : done}
    </span>
  );
}
