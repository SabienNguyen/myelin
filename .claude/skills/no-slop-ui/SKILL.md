---
name: no-slop-ui
description: UI and visual-design standards for the myelin client — use before creating or editing anything under src/client (components, CSS, blocks, UI copy), and when reviewing a UI diff. This app has a deliberate warm-paper design language with its own token set, serif type stack, and real ARIA patterns; the job of this skill is to keep new work inside that language instead of regressing to generic AI-default UI (Tailwind, Inter, indigo gradients, emoji icons, glassmorphism).
---

# No-Slop UI (harness client)

The client is plain CSS (~994 lines in `src/client/styles.css`) plus React 19. There is no Tailwind,
no shadcn, no component library. That is a choice, not an omission.

The design language is a **warm paper study**: cream ground, ink text, one muted blue accent, serif
display type. Default AI-generated UI is the opposite of this — cool grey, Inter, indigo-to-purple
gradient, rounded-2xl cards, emoji. Producing that here is the slop this skill exists to prevent.

Read `src/client/styles.css` `:root` before writing a single rule.

## Relationship to the `hallmark` skill

This repo also vendors [Hallmark](../hallmark/VENDORED.md), a general anti-AI-slop design rule-set.
The two do not compete — they have different scopes:

- **This skill and `/design.md` are authoritative for anything already built.** `design.md` is the
  locked design system; Hallmark's pre-flight (its Step 0) reads it first and defers to it, so it
  will not pick a theme or a font for you.
- **Use `hallmark audit <target>`** to score a UI diff against its anti-pattern list. It returns a
  ranked punch list and does not edit. This is the most useful verb here.
- **Use `hallmark study <url|screenshot>`** when the user supplies a visual reference to work from.
- **Do not run Hallmark's greenfield flow or `hallmark redesign` on existing panels** — macrostructure
  selection, theme catalogs, and hero enrichment assume a marketing page. This app is a dense
  single-user instrument with an established fingerprint. Greenfield Hallmark is appropriate only for
  a genuinely new standalone surface, and even then `design.md` constrains the palette, type, and
  motion.

If Hallmark's advice and `design.md` ever conflict, `design.md` wins. Say so rather than splitting
the difference.

## Tokens: never hardcode a value

Every color, radius, shadow, and font goes through a custom property. All of them already have a
`@media (prefers-color-scheme: dark)` override, so using tokens *is* how dark mode works.

```
--bg  --bg-panel  --bg-inset          surfaces (ground, raised, recessed)
--text  --text-muted                  type
--border                              hairlines
--accent  --accent-soft  --accent-text single accent + its wash + type on accent
--good  --bad  --warn                 semantic status only
--radius (10px)  --radius-sm (6px)    corners
--shadow                              one subtle elevation, that's it
--font-serif   Fraunces Variable      display, headings, block titles
--font-prose   Newsreader Variable    long-form reading and drafts
--font-mono    JetBrains Mono         code and editors
system-ui                             chrome, controls, labels
```

- A raw hex in a component or new CSS rule is a bug. If you need a shade that does not exist, add a
  token with a dark-mode counterpart.
- Do not introduce a second accent hue. Emphasis comes from weight, size, and `--accent-soft`.
- `--good`/`--bad`/`--warn` carry meaning. Never use them decoratively.

## Banned by default

- **Gradients.** No `linear-gradient` backgrounds on panels, buttons, or headers.
- **Glassmorphism.** No `backdrop-filter`, no translucent floating cards.
- **Emoji as iconography.** Icons come from `@phosphor-icons/react`. Emoji do not appear in the UI.
- **A UI framework or CSS-in-JS.** Extend `styles.css`.
- **A CDN.** Fonts are bundled locally via `@fontsource` (imported in `main.tsx`). Never add a
  `<link>` to Google Fonts or a script tag to a CDN — this is a localhost app that must work offline.
- **Animation theatre.** The house transition is `0.12s` on `background` and `border-color`. No
  entrance animations, no bounce, no spring, no shimmer skeletons. A `role="status"` spinner during
  real work is correct; motion for delight is not.
- **Oversized empty space.** This is a single-user information tool, not a marketing page. Prefer
  density: real padding is `0.35rem 0.85rem` on a button, not `py-4 px-8`.

## Accessibility is already load-bearing — match it

The existing components do real ARIA, not decoration. Copy these patterns:

- Tabs: `role="tablist"` / `role="tab"` + `aria-selected` — `SidePanel.tsx`, `GraphPanel.tsx`.
- Menus: `role="menu"` / `role="menuitem"` with arrow-key navigation — `HistoryMenu.tsx`.
- Live regions: `role="status"` for async progress — `LibraryPanel.tsx`, `Thread.tsx`,
  `CodeExercise.tsx`.
- Destructive confirms: `role="alertdialog"` — `CodeExercise.tsx`.
- Every icon-only control gets `aria-label`; purely decorative glyphs get `aria-hidden="true"`.

Rules:
- Interactive means `<button>`. Never a `<div onClick>`.
- `:focus-visible` outlines are global (`2px solid var(--accent)`). Never set `outline: none`.
- Buttons in forms need explicit `type="button"` unless they submit.

## Structure: use the existing seams

Do not invent a parallel mechanism for something the client already solves.

- **Tabs and panels** — `SidePanel` owns the `stage` / `graph` / `page` / `library` tabs. Add to it;
  do not build a second panel host.
- **Cross-component events** — `panelBus` (`openPage`, `setTab`, `focusMode`). Not a new context, not
  a global.
- **Deep links** — `urlState.ts` owns the `#/t/<threadId>[/<tab>|/page/<slug>]` hash. `App` owns the
  threadId slice, `SidePanel` owns tab/page, and each preserves the other's. Respect that split.
- **Blocks in the Stage** — render through `StagePortal` into `#stage-root`.
- **Model output is untrusted text** — it goes through `scrubModelArtifacts` (`panelBus.ts`) before
  render, because degenerate local models leak raw ChatML control tokens.

## UI copy

Terse and lowercase-leaning, matching `auto-compiling in the background`. No exclamation marks, no
praise, no personality. The tutor prompt bans narrating block mechanics ("The block is displayed",
"Go ahead and answer above"); UI strings live under the same rule — add information or say nothing.

Error text names what failed and what the user can do. `ingest failed: <reason>` is right;
`Something went wrong 😕` is not.

## Tests

Client tests live in `tests/client/` and use Testing Library. Query by role and accessible name —
`getByRole('tab', { name: 'graph' })` — not by class name. If a control is hard to query by role,
that is usually an accessibility bug in the component, not a reason to reach for a test id.

## Self-check before committing UI

1. Any raw hex, `rgb()`, or px font-size that should be a token?
2. Does it read correctly in dark mode — did you actually check both schemes?
3. Is every interactive element a real control, with an accessible name and a visible focus ring?
4. Did you add a gradient, an emoji, a CDN link, or an animation?
5. Does it look like it belongs beside the existing panels, or like it came from a different app?
