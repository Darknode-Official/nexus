# Nexus Terminal UI — Environment Matrix (UI-009)

This matrix is **honest about what was verified and how**. "It looks good on my
terminal" is not verification. Two classes of evidence are distinguished:

- **[PROG]** Verified programmatically / deterministically in this repo — by the
  test suite (`npm test`) and the committed render artifacts in
  [`ui-evidence/`](./ui-evidence/), regenerated with `npm run evidence`.
- **[HUMAN]** Requires a human looking at a real terminal emulator (color
  fidelity, font/glyph coverage, cursor-redraw smoothness, actual background
  detection round-trips). **Not yet done** in this environment — listed so it is
  not mistaken for complete.

## Color depths

| Depth | [PROG] evidence | Status |
| --- | --- | --- |
| truecolor (24-bit) | `ui-evidence/truecolor-dark-100.*`, `truecolor-light-100.*`; test asserts `38;2;r;g;b` | Verified |
| 256-color | `ui-evidence/256-dark-100.*`; test asserts `38;5;n` from the hand-authored table | Verified |
| 16-color | `ui-evidence/16-dark-100.*`, `16-light-100.*`; test asserts ANSI codes | Verified |
| no-color | `ui-evidence/none-*`; test asserts raw text + ASCII markers | Verified |

## Widths

| Width | [PROG] evidence | Status |
| --- | --- | --- |
| 80 | `none-dark-80.*`, `none-dark-80-ascii.*` | Verified — all rows width-exact |
| 100 | all `*-100.*` configs | Verified |
| 120 | `none-dark-120.*` | Verified |
| 200 | `none-dark-200.*` | Verified |
| below 80 | panel/composer tests run at 50 & 60 cols | Verified (degrades, no overflow) |

## Backgrounds

| Background | [PROG] | Measured contrast (vs `surface.base`) |
| --- | --- | --- |
| dark | `*-dark-*` artifacts; WCAG script | All text + semantic tokens **AA** (text.primary 16.96:1, muted 6.31:1, info 5.38:1, accentAlt/role.user 4.55:1) |
| light | `*-light-*` artifacts; WCAG script | All text + semantic tokens **AA** (text.primary 15.70:1, muted 4.77:1, accent 4.53:1, success 4.74:1) |

Background **detection** (COLORFGBG parsing, OSC 11 reply parsing) is [PROG]
unit-tested. Live OSC 11 round-trips against real terminals are [HUMAN].

## Non-TTY / piped / CI

| Case | [PROG] | Status |
| --- | --- | --- |
| piped to a file | `resolveDepth(..., {isTTY:false})` → none; the `.txt` artifacts are exactly this output | Verified |
| piped to a program | same no-TTY path | Verified |
| CI | `CI` env disables motion; no-TTY → no color | Verified |
| `--plain` | forces no-color linear output | Verified (flag + apply tested) |
| screen-reader mode | no cursor control, linear | Verified (flag + apply tested); [HUMAN] with a real screen reader |

## Unicode / ASCII fallback

| Case | [PROG] | Status |
| --- | --- | --- |
| box-drawing (UTF-8 locale) | all unicode configs | Verified |
| ASCII fallback (non-UTF-8) | `none-dark-80-ascii.*`; panel test runs ascii mode | Verified |
| CJK / emoji / flags / combining | width test corpus | Verified (width-correct) |

## Terminal emulators — [HUMAN], NOT YET TESTED

The following require running `npm run evidence` and `cat`-ing the `.ansi` files
(or running the host `darknode-cli`) inside each emulator and judging color
fidelity, glyph coverage, and redraw behavior. **None have been human-verified in
this environment.**

| Terminal | truecolor | glyphs | cursor redraw | notes |
| --- | --- | --- | --- | --- |
| iTerm2 | — | — | — | pending |
| Terminal.app | — | — | — | pending (truecolor limited) |
| Windows Terminal | — | — | — | pending |
| GNOME Terminal | — | — | — | pending |
| Alacritty | — | — | — | pending |
| Kitty | — | — | — | pending |
| WezTerm | — | — | — | pending |
| tmux | — | — | — | pending (depth passthrough) |
| screen | — | — | — | pending |
| SSH session | — | — | — | pending |
| container (no TERM) | — | — | — | pending (should resolve to 16/none) |

## How to reproduce

```
npm test            # 157 tests incl. the UI invariants
npm run evidence    # regenerate docs/ui-evidence/*
cat docs/ui-evidence/truecolor-dark-100.ansi   # view in a real terminal
NO_COLOR=1 cat docs/ui-evidence/none-dark-80.txt
```
