# design.md — loreweaver-harness

The locked design system for this project. Hallmark's pre-flight (Step 0) reads this file first and
defers to it: **do not pick a theme, do not pick a macrostructure for existing surfaces, do not
introduce a font or a hue.** This app already has a fingerprint. The job is to stay inside it.

Scope note: this is a single-user localhost tool, not a marketing site. There is no landing page,
no hero, no CTA funnel. Hallmark verbs that assume a marketing page (`redesign` with a new section
rhythm, hero enrichment) do not apply to the app shell. `hallmark audit` does apply, and is welcome.

## Genre and tone

**Warm paper study.** Editorial and utilitarian at once: the reading surface of a good print
reference, wrapped around a dense single-user instrument. Cream ground, ink text, one muted blue
accent, serif display type.

Tone, in Hallmark's vocabulary: **editorial + utilitarian**. Not playful, not luxury, not brutalist.

The anti-target is the LLM default: cool grey, Inter, indigo→purple gradient, `rounded-2xl` cards,
emoji, glassmorphism, entrance animations. Producing that here is a regression, not a redesign.

## Framework and stylesheet

- React 19 + Vite 8. No Next.js, no Astro.
- **Plain CSS**, one file: `src/client/styles.css` (~994 lines). No Tailwind, no CSS-in-JS, no
  component library (no shadcn, no MUI, no Radix).
- Add styles by extending `styles.css`. Do not introduce a second styling mechanism.

## Palette — tokens only, never a raw value

All colour lives in `:root` custom properties in `src/client/styles.css`, each with a
`@media (prefers-color-scheme: dark)` counterpart. Using tokens *is* how dark mode works.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--bg` | `#f5f2ea` | `#1d1b16` | page ground |
| `--bg-panel` | `#fdfbf6` | `#24221c` | raised surface |
| `--bg-inset` | `#ebe6da` | `#2c2a22` | recessed surface |
| `--text` | `#26241f` | `#e7e1d2` | body type |
| `--text-muted` | `#7d7668` | `#948d7b` | secondary type |
| `--border` | `#ddd5c5` | `#3b382d` | hairlines |
| `--accent` | `#3b5b8c` | `#93aed4` | the single accent |
| `--accent-soft` | `#e7ecf4` | `#2b3547` | accent wash |
| `--accent-text` | `#fdfbf6` | `#1d1b16` | type on accent |
| `--good` | `#38754f` | — | semantic: pass/correct |
| `--bad` | `#a84d3f` | — | semantic: fail/incorrect |
| `--warn` | `#a87b2f` | — | semantic: caution |

Rules:
- A raw hex, `rgb()`, or `oklch()` in a component or new rule is a bug. Need a new shade? Add a
  token *with* its dark counterpart.
- **One accent hue.** Emphasis comes from weight, size, and `--accent-soft` — never a second hue.
- `--good` / `--bad` / `--warn` are semantic. Never decorative.
- No gradients. No `backdrop-filter`.

## Typography

Four stacks, all bundled locally via `@fontsource` (imported in `src/client/main.tsx`). **Never add
a CDN `<link>` or `@import url(fonts.googleapis.com)`** — this app must work offline.

| Token | Family | Used for |
| --- | --- | --- |
| `--font-serif` | Fraunces Variable | display, headings, block titles |
| `--font-prose` | Newsreader Variable | long-form reading, drafts, page bodies |
| `--font-mono` | JetBrains Mono | code, editors, CodeMirror panes |
| *(base)* | `system-ui` | chrome, controls, labels |

Base size `15px`, `line-height: 1.6`. Heading weight tops out around `560` — Fraunces is variable,
so weight is tuned, not stepped. Do not introduce Inter, Geist, or a fifth family.

## Shape, elevation, spacing

- `--radius: 10px` (panels, cards), `--radius-sm: 6px` (controls). No `rounded-2xl` equivalents.
- `--shadow`: one subtle elevation (`0 1px 2px` at low alpha). There is no elevation scale; do not
  invent `shadow-lg`.
- **Spacing has no token scale** — it is informal rem steps, clustering at
  `0.3 / 0.4 / 0.5 / 0.6 / 0.9rem`, with `0.6rem` the most common gap. Match that rhythm rather
  than importing a 4-pt/8-pt scale.
- **Density over whitespace.** A button is `0.35rem 0.85rem`, an input `0.45rem 0.7rem`. This is an
  instrument panel, not a hero section. Generous padding here reads as a different product.

## Motion — motion-cut

Zero motion libraries in `package.json` (no framer-motion, gsap, lenis, react-spring, lottie).
Keep it that way.

The whole vocabulary in use: `0.12s` on `background` / `border-color` / `filter`, `0.15s` on
`opacity`, and `0.3–0.4s ease` on `width` for progress meters. That is all.

No entrance animations, no bounce, no spring, no parallax, no shimmer skeletons. A `role="status"`
spinner during genuinely pending work is correct; motion for delight is not.

`prefers-reduced-motion: reduce` already kills all animation and transition globally
(`styles.css` § "Motion is optional"). Anything you add inherits that — do not defeat it.

## Interaction and accessibility (load-bearing, not decoration)

- `:focus-visible` is globally `2px solid var(--accent)` with `1px` offset. **Never**
  `outline: none`.
- Interactive means `<button>`. Never a `<div onClick>`. Buttons in forms need explicit
  `type="button"` unless they submit.
- Existing ARIA patterns to copy rather than reinvent:
  - tabs — `role="tablist"` / `role="tab"` + `aria-selected` (`SidePanel.tsx`, `GraphPanel.tsx`)
  - menus — `role="menu"` / `role="menuitem"` with arrow-key nav (`HistoryMenu.tsx`)
  - live regions — `role="status"` (`LibraryPanel.tsx`, `Thread.tsx`, `CodeExercise.tsx`)
  - destructive confirm — `role="alertdialog"` (`CodeExercise.tsx`)
- Icon-only controls get `aria-label`; decorative glyphs get `aria-hidden="true"`.
- **Icons come from `@phosphor-icons/react`. No emoji in the UI, ever.**

## Copy voice

Terse, lowercase-leaning, informational. `auto-compiling in the background` is the register.

No exclamation marks, no praise, no personality, no `Oops!`. Errors name what failed and what the
user can do: `ingest failed: <reason>`. The tutor prompt bans narrating block mechanics ("The block
is displayed", "Go ahead and answer above") — UI strings live under the same rule: add information
or say nothing.

## Structural seams — use them, don't build parallels

- Tabs and panels: `SidePanel` owns `stage` / `graph` / `page` / `library`. Extend it.
- Cross-component events: `panelBus` (`openPage`, `setTab`, `focusMode`).
- Deep links: `urlState.ts` owns the `#/t/<threadId>[/<tab>|/page/<slug>]` hash. `App` owns the
  threadId slice, `SidePanel` owns tab/page; each preserves the other's.
- Blocks render into `#stage-root` via `StagePortal`.
- Model output is untrusted: it passes through `scrubModelArtifacts` (`panelBus.ts`) before render,
  because degenerate local models leak raw ChatML control tokens.

## What Hallmark may introduce here

Welcome: the slop-test gates, the anti-pattern audit, microinteraction discipline, structural
critique of *new* surfaces, accessibility review.

Not welcome without explicit user confirmation: a theme from the catalog, a new font stack, a second
accent hue, a motion library, a macrostructure applied to an existing panel, gradients, emoji, or a
rewrite of `styles.css` into a token system that isn't the one above.
