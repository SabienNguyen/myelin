// Ported VERBATIM from ~/Dev/personal/the-gap apps/web/src/SyntaxErrorNote.tsx (READ ONLY there).
// "Syntax errors reported inline, gap code NEVER echoed back styled as a solution." Muted styling,
// no modal — just a note under the editor.

export function SyntaxErrorNote({ message }: { message: string }) {
  return (
    <p className="syntax-error-note" role="status">
      {message}
    </p>
  );
}
