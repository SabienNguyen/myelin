export type PanelEvent =
  | { type: 'openPage'; slug: string }
  | { type: 'setTab'; tab: 'stage' | 'graph' | 'page' }
  | { type: 'teachMe'; slug: string };

type Fn = (e: PanelEvent) => void;
const subs = new Set<Fn>();
export const panelBus = {
  subscribe(fn: Fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  emit(e: PanelEvent) { subs.forEach((f) => f(e)); },
  openPage(slug: string) { this.emit({ type: 'openPage', slug }); },
  setTab(tab: 'stage' | 'graph' | 'page') { this.emit({ type: 'setTab', tab }); },
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

export const chatPreprocess = (md: string): string => mathDelims(wikiPreprocess(md));
