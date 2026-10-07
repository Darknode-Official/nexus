# Nexus Terminal Interface — Design System

Nexus renders to a terminal. There is no CSS. The materials are ANSI SGR
sequences, a color palette, box-drawing characters, whitespace, the cursor, and
the character grid. This document is the contract for how those materials are
used. Every render path imports from `src/ui/` and nothing else formats output.

## One palette, three renderers

The terminal, the web console (`darknode-web/public/js/coder.js`), and the
desktop app must read as one product. They share **one palette**, defined once in
[`src/ui/theme.js`](../src/ui/theme.js) and transcribed directly from
darknode-web's stylesheet tokens:

| Source (darknode-web) | What it provides |
| --- | --- |
| `public/css/styles.css` `:root` (dark) | surface, text, semantic, accent values |
| `public/css/styles.css` `:root[data-theme=light]` | the light palette |
| `public/css/styles.css` `.nx-*` role classes | the exact role vocabulary (agent `●`=`--acc`, user `›`=`--acc-2`, meter=`--mut`, ok=`--ok`, rule=`--line`) |
| `public/css/console.css` `--con-*` + `data-color` | console surface + category hues |

A color used by one renderer but not available to the others is a defect. The
test `every token is defined in both backgrounds and all mapping tables`
enforces parity; a web/desktop bridge can read the raw hex via `theme.hex(token)`.

## Token groups (`theme.js`)

- **Surface**: `base, raised, overlay, border, borderSubtle`
- **Text**: `primary, secondary, muted, placeholder, inverted`
- **Semantic**: `success, warning, error, info, accent, accentAlt`
- **Syntax**: `keyword, string, number, comment, function, type, variable,
  constant, operator, tag, attribute, punctuation`
- **Diff**: `added/removed/context/meta/hunk` + `*Bg` and `*BgIntra` variants
- **Role**: `user, agent, agentText, tool, toolResult, system, meter, prompt, rule`
- **Spacing**: 2-column indent unit (indentation is the primary structural
  device — UI-008), 1-row vertical rhythm
- **Borders**: `rounded` (input/attention), `square` (nested), `thin` (rules),
  `ascii` (fallback)

## Color depths (resolved once at startup)

`theme.resolveDepth()` chooses from terminal capability:

1. **truecolor** (24-bit) — preferred; `COLORTERM=truecolor`, known terminals.
2. **256-color** — a **hand-authored** mapping table per background
   (`MAP256_*`), not auto-quantisation.
3. **16-color ANSI** — legible, chosen per background so text never fights the
   user's background (`MAP16_*`).
4. **no-color** — `NO_COLOR`, non-TTY, piped, `TERM=dumb`, CI. Every distinction
   carried by color also survives as a symbol, label, or indentation (UI-010).

Overrides: `NEXUS_COLOR`, `FORCE_COLOR`, `NO_COLOR`.

## Light and dark backgrounds (UI-002)

`theme.resolveBackground()` reads `COLORFGBG`, then `NEXUS_BG`, then a
configurable default (never blindly dark). `parseOSC11()` converts an OSC 11
reply to a background decision for hosts that perform the async query. Both
palettes meet **WCAG AA** — measured ratios are in [`UI-MATRIX.md`](./UI-MATRIX.md).
The terminal never paints a full background fill that fights the user's; surface
background tokens are used only for local fills (diff line backgrounds, selected
overlay rows).

## The composer (UI-004) — the anchor

[`src/ui/composer.js`](../src/ui/composer.js). A rounded bordered box anchored at
the bottom, growing upward as input wraps (max rows, then internal scroll with a
"↑ more" cue), a quiet prompt marker, a status line (engine+model · ctx meter ·
tokens · cost · mode), and a distinct working-vs-awaiting frame state. The
`ComposerModel` is a pure line-editing state machine (word movement/deletion,
home/end, kill-to-eol, history with partial-draft preservation, history search,
bracketed-paste with large-paste collapse). The live key loop lives in the host
(`darknode-cli`), which drives this model and prints these frames.

## Borders, sparingly (UI-003)

Boxing everything turns the screen into a grid so nothing stands out. Frames are
reserved for surfaces that take input or demand attention (composer, completion
overlay, confirmation prompts). Flowing output uses whitespace, indentation, a
left rule for code blocks, and thin section rules — never a full-width box.

## Module map

| Module | Responsibility | Items |
| --- | --- | --- |
| `theme.js` | palette, depths, backgrounds, escapes (only here) | UI-001, UI-002 |
| `width.js` | grapheme-aware width/truncate/wrap | UI-008 |
| `symbols.js` | restrained symbols + ASCII equivalents | UI-008 |
| `box.js` | borders, rules, panels | UI-003 |
| `highlight.js` + `render.js` | roles, markdown, diffs, tool collapse | UI-005, UI-011 |
| `composer.js` | the input composer | UI-004 |
| `plan.js` | plan, progress, agent tracks, confirms | UI-006 |
| `spinner.js` | motion, reduced-motion fallback | UI-007 |
| `accessibility.js` | `--plain`, screen-reader, errors | UI-010 |
| `index.js` | single entry point | UI-011 |

## Invariants (enforced by tests)

- No raw escape sequence outside `theme.js`.
- No literal hex color inside `src/ui/` outside `theme.js`.
- Every token defined in both backgrounds and all three mapping tables.
- Every panel/composer row is exactly the requested width (unicode + ASCII).
- Markup distinctions survive NO_COLOR as ASCII markers / symbols.
