# Myelin — learning workspace design

## Direction

A desktop learning workspace inspired by Poolside/Amp's restrained developer-tool aesthetic,
not a clone of either product. Neutral surfaces, compact monospace chrome, clear divisions,
minimal elevation. No marketing page, decorative gradients, glass, or gratuitous animation.
The learner's work, evidence and subject graph remain the product.

## Stack and structure

React 19, Vite, assistant-ui primitives and the existing Electron shell (Linux, macOS, Windows
packaging targets). Reuse assistant-ui's runtime and message components instead of implementing
another chat stack. Plain CSS in `src/client/styles.css` is the only token source.
A component-library overhaul is permitted when it demonstrably improves a surface, not as a
prerequisite for changing colors. Do not break the tutor/Engram evidence contract for styling.

## Palette and geometry

Dark default with an explicit OS light-preference counterpart. Higher-contrast OS settings
increase border and secondary-text contrast. All colors are tokens; verdict colors are semantic,
never decorative. The graph's mastery scale is separate from its grading verdict.

| Token | Dark | Light |
| --- | --- | --- |
| bg | #101116 | #eeeef7 |
| bg-panel | #17191f | #ffffff |
| bg-inset | #21242c | #e4e5f0 |
| text | #edeef2 | #1f2128 |
| text-muted | #a5a9b6 | #565a68 |
| border | #3a3e4a | #c9cbd8 |
| accent | #93b4f7 | #2b55c4 |
| accent-soft | #1f2a44 | #e3e9fb |
| good | #85cba0 | #27613f |
| bad | #f09c95 | #9b3632 |
| warn | #e5c17e | #765319 |

The neutrals carry a slight blue tint and the single accent is blue. The window is the tinted
ground (`bg`); the top bar sits directly on it, and the working area (transcript plus side panel)
is one raised canvas (`bg-panel`) inset from the window edge. There is no navigation rail:
conversations are switched from the top bar's history menu.

Corners are soft and step down as surfaces nest: `--radius-shell` (14px) for the canvas, the
composer card and floating popovers; `--radius` (10px) for cards and message bubbles;
`--radius-sm` (7px) for controls. Status badges are pills and the send button is a circle.

A border is for something you type into or press. Everything else separates by fill or by
space: transcript blocks and the user's bubbles are borderless fills, and a block on the Stage has
no box at all, because the tab body is already its container (consecutive Stage blocks are split
by a rule). Sharp 2px corners with a border on every surface were tried and rejected as boxy.

The transcript sits on the composer card's 45rem measure, so prose, blocks, bubbles and the card
share both edges; the top bar ends where the canvas ends; the tab underline starts where the Stage
content starts. The transcript's scrollbar has a width set in CSS so that measure can account for it.

No panel shadows. Circular graph nodes, status dots and functional markers
remain circles. Hairline borders divide surfaces; focus rings identify active controls.
Text, secondary text, accent and graded verdicts meet WCAG AA on all three neutral surfaces,
verified by `tests/designTokens.test.ts`. This test is not a claim that every blended state has
been audited. Borders are intentionally subdued; high-contrast mode strengthens them.

## Typography and density

System sans-serif is used for workspace headings, tabs, status controls and long lessons;
JetBrains Mono is bundled locally for code, technical headings and the wordmark. No font CDN.
The composer is a unified, centered card capped at 760px, with secondary controls in its bottom
row. Symbol keys use neutral surfaces and open above the composer rather than resizing it.
Empty Stage offers library and graph navigation and disappears when an exercise or summary arrives. `--font-serif` is a compatibility alias to `--font-mono`,
not a second design language. Base 15px, prose line-height 1.75; preserve the compact controls and
responsive layout. Micro-labels may be uppercase; sentences remain normal case.

## Motion

Brief hover/focus transitions only. Respect the existing global reduced-motion rules. Graph
simulation is functional, not decoration; preserve zoom, drag, keyboard access and cleanup.

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


## OpenRouter setup

First-run setup offers a write-only OpenRouter key and an all-role free-router preset. The models
panel offers current zero-priced, tool-capable `:free` models from the public catalog. No paid
fallback is selected automatically. Explain rate limits and that lesson content leaves the device.
Keep secrets out of responses, screenshots, source control and the learner's vault.

## Verification

Run typecheck, unit tests and the sequential Playwright suite. Exercise graph navigation, keyboard
controls, learning blocks, setup errors and responsive layouts. Tests use isolated config and vaults,
not the user's real credentials or learning data. Linux execution alone does not verify macOS or
Windows installers; report that limitation rather than claiming cross-platform certification.
