export type PanelTab = 'stage' | 'graph' | 'page' | 'library';
export type PanelEvent =
  | { type: 'openPage'; slug: string }
  | { type: 'openSource'; path: string; title: string }
  | { type: 'setTab'; tab: PanelTab }
  | { type: 'teachMe'; slug: string }
  // P1 (docs/superpowers/plans/2026-07-20-gap-integration.md): a code_exercise block toggles
  // this on mount-with-no-result / off on unmount (CodeExercise.tsx's cleanup effect — covers
  // both "learner finishes/stops" (parent unmounts the block) and reload safety). App.tsx is the
  // only subscriber that matters today — it flips `.app.focus-mode` — but this stays a bus event
  // rather than e.g. a prop so nothing has to thread focus state through Thread/SidePanel's props.
  | { type: 'focusMode'; on: boolean };

type Fn = (e: PanelEvent) => void;
const subs = new Set<Fn>();
export const panelBus = {
  subscribe(fn: Fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  emit(e: PanelEvent) { subs.forEach((f) => f(e)); },
  openPage(slug: string) { this.emit({ type: 'openPage', slug }); },
  openSource(path: string, title: string) { this.emit({ type: 'openSource', path, title }); },
  setTab(tab: PanelTab) { this.emit({ type: 'setTab', tab }); },
  setFocusMode(on: boolean) { this.emit({ type: 'focusMode', on }); },
};

export function wikiPreprocess(md: string): string {
  return md.replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g,
    (_, slug, label) => `[${label || slug}](#/page/${slug.trim()})`);
}

/** Models emit LaTeX with \(inline\) and \[display\] delimiters; remark-math only parses
 * $-delimiters. Without this, react-markdown eats the backslashes and the student sees
 * "( f(x) = 3x^2 )" as broken prose instead of typeset math. */
export function mathDelims(md: string): string {
  return md
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => `\n$$\n${tex}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => `$${tex}$`);
}

/** Local models occasionally degenerate and echo their chat-template control tokens
 * (`<|im_start|>assistant`, `<|endoftext|>`, ...) as literal text instead of the harness ever
 * seeing them as structure — server-side stop tokens are the root fix, but already-saved threads
 * still contain the garbage, and other local models leak differently-shaped markers. This strips
 * any `<|...|>`-style marker (optionally swallowing an immediately-following ChatML role word,
 * since that's the shape that actually leaks: `<|im_start|>assistant `) and tidies the whitespace
 * left behind. Chat-only: PagePanel renders trusted vault content straight through
 * `wikiPreprocess` and must not run this. */
export function scrubModelArtifacts(md: string): string {
  return md
    // `<|im_start|>` / `<|im_end|>`, optionally followed by a ChatML role word and the
    // whitespace/newline right after it (e.g. "<|im_start|>assistant\n" or "<|im_end|> user ").
    .replace(/<\|(?:im_start|im_end)\|>(?:[ \t]*(?:assistant|user|system)\b[ \t]*\n?)?/g, ' ')
    // any other `<|marker|>` token: `<|endoftext|>`, or an unrecognized `<|foo_bar|>`.
    .replace(/<\|[a-z_]+\|>/gi, ' ')
    // collapse the blank runs the removals leave behind.
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export const chatPreprocess = (md: string): string =>
  mathDelims(wikiPreprocess(scrubModelArtifacts(md)));
