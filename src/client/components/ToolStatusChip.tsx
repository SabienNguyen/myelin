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

export function ToolStatusChip({ toolName, result }: any) {
  const failed = result && typeof result === 'object' && (result as any).isError;
  const [done, notDone] = LABELS[toolName] ?? [toolName, `${toolName} failed`];
  // Deliberately typographic, not a pill — reads as quiet marginalia, not UI chrome.
  return (
    <span className={`tool-note${failed ? ' failed' : ''}`} title={toolName}>
      {failed ? `✗ ${notDone}` : done}
    </span>
  );
}
