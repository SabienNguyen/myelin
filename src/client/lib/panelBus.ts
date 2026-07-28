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

/** Segments a markdown string so a blanket text transform skips what must stay verbatim: fenced
 * code (```), inline code (`…`), and $$…$$ math blocks. Used with String.split — the capturing
 * group puts each protected run at an ODD index, so callers transform only the even-index text
 * segments. Shared by the loose-dollar escaper and the \(…\)/\[…\] delimiter converter: a `\[`
 * shown INSIDE a code span is the delimiter as content (a LaTeX-syntax lesson, a regex with an
 * escaped bracket), not math, and neither transform may rewrite it. */
const PROTECTED_SPANS = /(```[\s\S]*?(?:```|$)|`[^`\n]*`|\$\$[\s\S]*?\$\$)/;

/** Models emit LaTeX with \(inline\) and \[display\] delimiters; remark-math only parses
 * $-delimiters. Without this, react-markdown eats the backslashes and the student sees
 * "( f(x) = 3x^2 )" as broken prose instead of typeset math. Code and $$-blocks are left verbatim
 * (PROTECTED_SPANS) — a lesson that SHOWS `\[` as code must not have it turned into a math block. */
export function mathDelims(md: string): string {
  return md
    .split(PROTECTED_SPANS)
    .map((seg, i) => (i % 2 ? seg : seg
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => `\n$$\n${tex}\n$$\n`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => `$${tex}$`)))
    .join('');
}

/** remark-math treats ANY `$…$` pair as inline math, so verbatim prose with two currency amounts
 * — "bought for $12,000 is sold for $19,500" (a banked exam problem, drilled word-for-word) —
 * typeset as garbage: KaTeX ate "$12,000 is sold for $" and ran the words together. Pandoc hit
 * the same ambiguity and settled adjacency rules we adopt here: a `$` only OPENS math when
 * followed by a non-space, and only CLOSES it when preceded by a non-space and not followed by a
 * digit. Every `$` that cannot take part in such a span is escaped to `\$` (CommonMark renders
 * that as a literal dollar), which leaves real notation like `$C_1V_1=C_2V_2$` untouched. Code
 * spans, fences, and `$$…$$` blocks pass through unmodified — an escape inside a code block
 * would surface as a literal backslash. */
export function escapeLooseDollars(md: string): string {
  return md
    .split(PROTECTED_SPANS)
    .map((seg, i) => (i % 2 ? seg : escapeLooseDollarsInText(seg)))
    .join('');
}

function escapeLooseDollarsInText(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\' && text[i + 1] === '$') { out.push('\\$'); i += 2; continue; }
    if (text[i] !== '$') { out.push(text[i]); i += 1; continue; }
    const next = text[i + 1];
    if (next !== undefined && next !== '$' && !/\s/.test(next)) {
      // Look for a valid closer before the paragraph ends — math never spans a blank line.
      let closer = -1;
      for (let j = i + 2; j < text.length && !(text[j] === '\n' && text[j - 1] === '\n'); j += 1) {
        if (text[j] !== '$' || text[j - 1] === '\\') continue;
        const after = text[j + 1];
        if (!/\s/.test(text[j - 1]) && !(after !== undefined && /\d/.test(after))) { closer = j; break; }
      }
      if (closer >= 0) { out.push(text.slice(i, closer + 1)); i = closer + 1; continue; }
    }
    out.push('\\$');
    i += 1;
  }
  return out.join('');
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

// escapeLooseDollars runs BEFORE mathDelims: it must only judge dollars the model (or a banked
// problem) wrote as `$`, never the `$…$` pairs mathDelims itself mints from `\(…\)`.
export const chatPreprocess = (md: string): string =>
  mathDelims(escapeLooseDollars(wikiPreprocess(scrubModelArtifacts(md))));
