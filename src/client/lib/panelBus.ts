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
