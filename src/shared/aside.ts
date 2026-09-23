export interface AsideSource { url: string; title?: string }
export interface AsideData {
  asideId: string;            // crypto.randomUUID()
  quote?: string;             // the selected text, when started from a selection
  question: string;           // what the learner typed; for a bare selection, `Explain "<quote>"`
  answer: string;             // markdown
  sources: AsideSource[];     // web sources actually used (server-tool-result / read_url)
  vaultPages: string[];       // slugs the answer read via read_page
  fromMemory: boolean;        // true when neither sources nor vaultPages grounded it
  createdAt: string;          // ISO
}
/** The UI message part stored on the anchored assistant message. */
export interface AsidePart { type: 'data-aside'; id: string; data: AsideData }
export interface AsideRequest { threadId: string; messageId: string; question: string; quote?: string }
export type AsideResponse = { part: AsidePart } | { error: string };
export const ASIDE_MAX_QUESTION = 2000;
