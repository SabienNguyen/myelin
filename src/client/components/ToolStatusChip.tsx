// Fallback UI for MCP (server-side) tool calls in the transcript. The learner should see a
// quiet status line — "✓ evidence recorded" — never raw JSON args, retries, or tool plumbing.
const LABELS: Record<string, string> = {
  record_evidence: 'evidence recorded',
  get_student_state: 'checked your progress',
  next_lessons: 'picked next lessons',
  find_analogies: 'looked for analogies',
  read_page: 'read a page',
  search: 'searched the vault',
  list_paths: 'checked paths',
  read_path: 'read a path',
  write_page: 'wrote a page',
  link_pages: 'linked pages',
  compile_source: 'compiled a source',
};

export function ToolStatusChip({ toolName, result }: any) {
  const failed = result && typeof result === 'object' && (result as any).isError;
  const label = LABELS[toolName] ?? toolName;
  // Deliberately typographic, not a pill — reads as quiet marginalia, not UI chrome.
  return (
    <span className={`tool-note${failed ? ' failed' : ''}`} title={toolName}>
      {failed ? '✗ ' : ''}{label}
    </span>
  );
}
