# design.md — myelin

The locked design system for this project. Hallmark's pre-flight (Step 0) reads this file first and
defers to it: **do not pick a theme, do not pick a macrostructure for existing surfaces, do not
introduce a font or a hue.** This app already has a fingerprint. The job is to stay inside it.

Scope note: this is a single-user localhost tool, not a marketing site. There is no landing page,
no hero, no CTA funnel. Hallmark verbs that assume a marketing page (`redesign` with a new section
rhythm, hero enrichment) do not apply to the app shell. `hallmark audit` does apply, and is welcome.

## System

The structured picks, in the shape Hallmark's pre-flight and amend flows read:

- Genre · **editorial** (utilitarian register; not modern-minimal, not atmospheric, not playful)
- Macrostructure · **n/a — app shell**, not a page. No hero, no marketing sections, no footer.
- Theme · **custom** (vibe: "warm paper study, dense instrument")
- Axes · paper-band **light** (dark counterpart via `prefers-color-scheme`) / display-style
  **high-contrast-serif** (Fraunces) / accent-hue **cool** (muted blue, 250°)
- Motion stance · **motion-cut**
- Tokens · `src/client/styles.css` `:root` is the source of truth. There is no `tokens.css`, and one
  must not be introduced — a second token file would immediately drift from the stylesheet the app
  actually loads.

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
| `--text-muted` | `#6b6456` | `#9b9483` | secondary type |
| `--border` | `#ddd5c5` | `#3b382d` | hairlines |
| `--accent` | `#3b5b8c` | `#93aed4` | the single accent |
| `--accent-soft` | `#e7ecf4` | `#2b3547` | accent wash |
| `--accent-text` | `#fdfbf6` | `#1d1b16` | type on accent |
| `--good` | `#356e4a` | `#6fae86` | semantic: pass/correct |
| `--bad` | `#a2493b` | `#d4867a` | semantic: fail/incorrect |
| `--warn` | `#845f1e` | `#c99a4a` | semantic: caution |

Rules:
- A raw hex, `rgb()`, or `oklch()` in a component or new rule is a bug. Need a new shade? Add a
  token *with* its dark counterpart.
- **One accent hue.** Emphasis comes from weight, size, and `--accent-soft` — never a second hue.
- `--good` / `--bad` / `--warn` are semantic. Never decorative.
- No gradients. No `backdrop-filter`.

### Contrast is a correctness requirement, not taste

`--good` / `--bad` / `--warn` carry the **graded verdict**. A learner misreading "incorrect" as
"correct" is a pedagogy failure, so these three are held to WCAG AA (4.5:1) for normal-size text on
whatever surface they actually render on — not to the 3:1 non-text floor.

Every token pair is verified with real WCAG math, both schemes, before a value changes. Current
worst cases: `--warn` 4.64 on `--bg-inset` (light), `--text-muted` 4.76 on `--bg-inset` (dark). The
one knowingly-failing pair is `--border` at 1.30:1 (light) / 1.47:1 (dark) — see § Accepted
deviations.

**Do not "harmonise" these three hues toward the accent.** Their job is to be distinguishable from
the accent and from each other, including for red-green colour blindness — which is why every
verdict also carries a text label or a glyph (`.verdict`, `.tool-note::before`, `.mark-ok`), never
colour alone.

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

## Variants

None. Every surface shares this one system — the diversification rule is inverted here, as Hallmark
specifies for a `design.md`-managed project: panels must look like each other, not differ.

If a genuinely new standalone surface ever needs different treatment, **amend this section** with a
named variant and its deltas. Do not override locally in a component; a local override is invisible
to the next audit and is how a second design language gets in.

## Exports

`src/client/styles.css` `:root` is the only export, and is canonical. Deliberately absent:

- **No `tokens.css`** — see § System. One source of truth, and it is the file the app loads.
- **No Tailwind `@theme`, no DTCG `tokens.json`, no shadcn CSS variables.** Nothing consumes them;
  each would be a second copy free to drift.

If a real consumer ever appears, generate its format *from* the `:root` block and say so here.

## Accepted deviations from Hallmark

Settled decisions. A future `hallmark audit` should **not** re-raise these as findings — and if it
does, the answer is this section, not a code change.

| Hallmark rule | Our state | Why |
| --- | --- | --- |
| OKLCH for every colour | hex | 12 tokens × 2 schemes with no visual change; contrast is verified with real WCAG math either way, which is what the rule is protecting. |
| 4-pt `--space-*` scale | informal rem steps (`0.3/0.4/0.5/0.6/0.9`, `0.6rem` most common) | The rhythm is already consistent and dense. Retrofitting a scale would touch nearly every rule to no visible end. |
| Named `--ease-*` / `--dur-*` tokens | literal `0.12s` / `ease` | Six declarations total. Tokenising is defensible but low-value; revisit if motion grows. |
| Macrostructure / nav + footer archetypes / hero enrichment / eyebrow rules | n/a | App shell, not a page. No hero, no footer, no marketing sections. |
| `tokens.css` emission · `.hallmark/log.json` | absent | Page-build artifacts. Nothing here is a page build. |
| CSS `/* Hallmark · macrostructure: … */` stamp | **absent, deliberately** | `verbs/audit.md` wants a stamp on a system-managed project, but the same file makes a stamp that misdescribes what shipped a `critical: stamp lies`. This stylesheet was hand-built and has no macrostructure — any stamp would be that lie. No stamp is the honest resolution. |
| `--border` ≥ 3:1 (WCAG 1.4.11) | 1.30:1 light / 1.47:1 dark by default; **3.05:1 / 3.03:1 under `prefers-contrast: more`** | The hairline *is* the paper aesthetic; darkening it by default changes the whole look. Mitigated three ways: every control also shifts `background` on hover and carries a 2px `--accent` focus ring (6.13:1), so the border is never the sole affordance cue — and a reader who has asked their OS for more contrast now gets a border that clears 3:1 against *all three* surfaces (bg / panel / inset), not just the page. Still the one open accessibility trade at default contrast. |
| Touch targets ≥ 44×44 | smallest is 29×29 (the history-menu icon button); most controls 26–41px tall | WCAG 2.2 SC 2.5.8 (AA) asks for 24×24 and every control clears it — measured across all four tabs. 44×44 is SC 2.5.5 (AAA) and mobile-first HIG guidance; this is a desktop-first single-user tool with no touch surface. Revisit if it ever ships to a tablet. |
