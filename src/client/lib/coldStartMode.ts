/** Which mode a session should open in, given the vault's graph nodes. Teaching modes are
 * grounded in the vault and cannot write pages (the single-writer rule — session.ts), so opening
 * a vault with nothing real to teach from in `learn` broke the empty-state promise ("your tutor
 * writes pages as you go"): the newcomer's first lesson researched well, taught well, and then
 * evaporated — no page, no graph node, nowhere for evidence to land (caught by the cold-start
 * audit). Freeform is the mode that keeps that promise. Stubs don't count as teachable — both the
 * boot-seeded pattern stubs and Engram's auto-created prereq stubs are placeholders, exactly
 * what vaultGap refuses to ground in. The first real page flips future sessions back to `learn`. */
export function coldStartMode(nodes: Array<{ status?: string }>): 'learn' | 'freeform' {
  return nodes.some((n) => n.status !== 'stub') ? 'learn' : 'freeform';
}
