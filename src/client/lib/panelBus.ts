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
  | { type: 'focusMode'; on: boolean }
  // A panel handing the tutor a ready-made request as a REAL user message (Thread.tsx is the
  // subscriber, reusing the composer's own send path). PagePanel's "claim you know this" is the
  // emitter today; a bus event for the same reason as focusMode — nothing threads composer access
  // through SidePanel's props.
  | { type: 'askTutor'; text: string }
  // A conversation was filed under a notebook from inside the workspace (NotebookPicker). Every
  // reader of "which notebook is this conversation in" — the topbar crumb, the empty state, the
  // graph's notebook scope — looked once per conversation and would otherwise go on saying none.
  | { type: 'notebookFiled'; threadId: string };

type Fn = (e: PanelEvent) => void;
const subs = new Set<Fn>();
export const panelBus = {
  subscribe(fn: Fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  emit(e: PanelEvent) { subs.forEach((f) => f(e)); },
  openPage(slug: string) { this.emit({ type: 'openPage', slug }); },
  openSource(path: string, title: string) { this.emit({ type: 'openSource', path, title }); },
  setTab(tab: PanelTab) { this.emit({ type: 'setTab', tab }); },
  setFocusMode(on: boolean) { this.emit({ type: 'focusMode', on }); },
  askTutor(text: string) { this.emit({ type: 'askTutor', text }); },
  notebookFiled(threadId: string) { this.emit({ type: 'notebookFiled', threadId }); },
};

/** Segments a markdown string so a blanket text transform skips what must stay verbatim: fenced
 * code (```), inline code (`…`), and $$…$$ math blocks. Used with String.split — the capturing
 * group puts each protected run at an ODD index, so callers transform only the even-index text
 * segments. Shared by ALL THREE chat text-preprocessors — the wiki-link rewriter, the loose-dollar
 * escaper, and the \(…\)/\[…\] delimiter converter — because syntax shown INSIDE code is content,
 * not markup: `[[note]]`, `\[`, or a bare `$` displayed AS CODE (a wiki-syntax lesson, a LaTeX
 * tutorial, a regex) must render literally, so no preprocessor may rewrite it. */
const PROTECTED_SPANS = /(```[\s\S]*?(?:```|$)|`[^`\n]*`|\$\$[\s\S]*?\$\$)/;

export function wikiPreprocess(md: string): string {
  return md
    .split(PROTECTED_SPANS)
    .map((seg, i) => (i % 2 ? seg : seg.replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g,
      (_, slug, label) => `[${label || slug}](#/page/${slug.trim()})`)))
    .join('');
}

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

// OpenAI's citation markup: U+E200, the word "cite", U+E202, a reference, U+E201. The
// three code points have no glyph, so an unhandled marker renders as tofu boxes around
// "cite" and the raw reference, mid-sentence. CITATION_SPAN's leading `(\s?)` group lets
// a single replacer decide, per match, whether to keep a pre-existing separating space,
// drop it, or add one — see citationLinks below.
const CITATION_SPAN = /(\s?)\uE200cite\uE202([^\uE201]*)\uE201/g;

/** A ref prefixed "Vault: " names a page the model read with read_page and becomes a `#/cite/`
 * link — WikiLink (MarkdownText.tsx) turns that into a citation chip that resolves back to the
 * page. Every other ref is an opaque web-search id (`turn0search0`, `turn1view2`, …): the
 * web_search tool chip already shows that source, so there is nothing useful to link and the
 * whole span is dropped, including the leading space it would otherwise leave dangling before
 * whatever punctuation follows ("results , that" -> "results, that"). Runs on the non-protected
 * segments only (PROTECTED_SPANS), same discipline as wikiPreprocess, so a lesson that shows this
 * exact markup AS CODE keeps it verbatim instead of linkifying or stripping it. */
export function citationLinks(md: string): string {
  return md
    .split(PROTECTED_SPANS)
    .map((seg, i) => (i % 2 ? seg : seg.replace(
      CITATION_SPAN,
      (_m: string, lead: string, ref: string, offset: number) => {
        const trimmed = ref.trim();
        if (!trimmed.startsWith('Vault:')) return '';
        const title = trimmed.slice('Vault:'.length).trim();
        const linkText = title.replace(/([[\]])/g, '\\$1');
        // encodeURIComponent leaves '(' and ')' unescaped (they're in its unreserved set), so a
        // title with parentheses would otherwise close the markdown link destination early.
        const href = encodeURIComponent(title).replace(/\(/g, '%28').replace(/\)/g, '%29');
        // `lead` already IS the separating whitespace when one preceded the marker; only a
        // marker glued directly onto a preceding character (offset > 0, nothing captured) needs
        // one inserted so the link text doesn't fuse onto the previous word.
        const space = lead || (offset > 0 ? ' ' : '');
        return `${space}[${linkText}](#/cite/${href})`;
      },
    )))
    .join('');
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
    // Backstop for OpenAI's citation markup (CITATION_SPAN, above): citationLinks runs first in
    // chatPreprocess and already turns a Vault: ref into a link and drops every other ref, but a
    // surface that renders raw model text without citationLinks must not show tofu either. The
    // second line mops up a malformed marker CITATION_SPAN can't match, e.g. one missing its
    // closing U+E201 — a stray private-use code point left on its own is still junk, not text.
    .replace(CITATION_SPAN, ' ')
    .replace(/[\uE200-\uE202]/g, ' ')
    // collapse the blank runs the removals leave behind.
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// citationLinks runs BEFORE scrubModelArtifacts: a Vault: ref must become a link while the
// citation span is still intact, before the scrub strips whatever citation markup is left over.
// escapeLooseDollars runs BEFORE mathDelims: it must only judge dollars the model (or a banked
// problem) wrote as `$`, never the `$…$` pairs mathDelims itself mints from `\(…\)`.
export const chatPreprocess = (md: string): string =>
  mathDelims(escapeLooseDollars(wikiPreprocess(scrubModelArtifacts(citationLinks(md)))));
