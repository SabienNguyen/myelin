// One way to say "on its way" across the panels, which had grown four ("Loading…", "loading
// notebooks…", "laying out the graph…", a bare "loading…"). Names what is coming, announces it
// politely, and draws a thin indeterminate bar that motion-reduced readers see standing still.
export function Loading({ what, className }: { what: string; className?: string }) {
  return (
    <p className={`loading${className ? ` ${className}` : ''}`} role="status">
      <span className="loading-bar" aria-hidden="true" />
      {what}…
    </p>
  );
}
