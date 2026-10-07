"use strict";
// ============================================================================
// Nexus Terminal Theme — the single source of truth for color and escapes.
// ----------------------------------------------------------------------------
// UI-001 (token system) + UI-002 (light/dark). This is the ONLY module in the
// repository permitted to contain raw ANSI escape sequences or literal color
// values. Every other render path imports tokens and paint helpers from here.
//
// ONE PALETTE, THREE RENDERERS: the values below are transcribed directly from
// darknode-web's stylesheet tokens so the terminal, the web console (coder.js),
// and the desktop app read as one product. Source of truth:
//   public/css/styles.css  :root            (dark, lines 9-41)
//   public/css/styles.css  :root[data-theme=light] (light, lines 42-54)
//   public/css/styles.css  .nx-* role classes (lines 1145-1155)
//   public/css/console.css  --con-* + data-color palette (lines 4-23)
// A color used by one renderer but not available to the others is a defect.
// ============================================================================

// ---------------------------------------------------------------------------
// 0. Escape primitives — the only raw \x1b in the codebase.
// ---------------------------------------------------------------------------
const ESC = "\x1b";
const CSI = ESC + "[";

// The one regex that recognises ANSI/CSI/OSC sequences. Lives here so the ESC
// character is authored in exactly one module; width.js imports it to measure
// and strip escapes without re-authoring the literal.
const ANSI_RE = new RegExp(
  ESC + "(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07" + ESC + "]*(?:\\x07|" + ESC + "\\\\)|[@-Z\\\\-_])",
  "g"
);
function stripAnsi(str) { return String(str).replace(ANSI_RE, ""); }

const control = {
  // Cursor movement / region control for transient redraws (spinners, composer).
  up: (n = 1) => CSI + n + "A",
  down: (n = 1) => CSI + n + "B",
  right: (n = 1) => CSI + n + "C",
  left: (n = 1) => CSI + n + "D",
  column: (n = 1) => CSI + n + "G",
  to: (row, col) => CSI + row + ";" + col + "H",
  savePos: ESC + "7",
  restorePos: ESC + "8",
  hideCursor: CSI + "?25l",
  showCursor: CSI + "?25h",
  clearLine: CSI + "2K",
  clearToEnd: CSI + "0K",
  clearDown: CSI + "0J",
  clearScreen: CSI + "2J" + CSI + "H",
  // Bracketed paste (UI-004): let the composer distinguish typed vs pasted input.
  enableBracketedPaste: CSI + "?2004h",
  disableBracketedPaste: CSI + "?2004l",
  // OSC 11 background-color query (UI-002).
  queryBackground: ESC + "]11;?" + ESC + "\\",
  reset: CSI + "0m",
};

// SGR style attributes.
const SGR = { reset: 0, bold: 1, dim: 2, italic: 3, underline: 4, inverse: 7, strike: 9 };

// ---------------------------------------------------------------------------
// 1. Canonical palettes (truecolor sRGB hex) — transcribed from darknode-web.
// ---------------------------------------------------------------------------
// Dark == styles.css :root. Light == styles.css :root[data-theme=light].
// Tokens the CSS derives with color-mix() are resolved to concrete hex here so
// the terminal (which has no color-mix) matches the rendered web surface.
const DARK = {
  // Surface levels
  "surface.base":          "#070a12", // --bg
  "surface.raised":        "#0f1726", // --card / --surface
  "surface.overlay":       "#151f34", // --card2
  "surface.border":        "#283a5a", // --line / --border
  "surface.borderSubtle":  "#1b2740", // color-mix(line 60%, bg) — subtle rules
  // Text levels
  "text.primary":          "#e6eefc", // --txt
  "text.secondary":        "#aebfdd", // --txt-2
  "text.muted":            "#7a93b8", // --mut
  "text.placeholder":      "#5f7294", // --placeholder
  "text.inverted":         "#04121a", // --on-acc (text drawn on an accent fill)
  // Semantic
  "semantic.success":      "#2ee6a6", // --ok
  "semantic.warning":      "#f5b041", // --warn
  "semantic.error":        "#ff5c6c", // --bad
  "semantic.info":         "#3b82f6", // console.css data-color=blue
  "semantic.accent":       "#00d4ff", // --acc
  "semantic.accentAlt":    "#7c5cff", // --acc-2 (user input, prompt marker)
  // Syntax (canonical code-highlight palette for all three renderers)
  "syntax.keyword":        "#7c5cff", // acc-2
  "syntax.string":         "#2ee6a6", // ok
  "syntax.number":         "#f5b041", // warn
  "syntax.comment":        "#7a93b8", // mut
  "syntax.function":       "#00d4ff", // acc
  "syntax.type":           "#7cc5ff",
  "syntax.variable":       "#e6eefc", // txt
  "syntax.constant":       "#ff9100", // citadel.js keyword orange
  "syntax.operator":       "#aebfdd", // txt-2
  "syntax.tag":            "#00d4ff", // acc
  "syntax.attribute":      "#f5b041", // warn
  "syntax.punctuation":    "#7a93b8", // mut
  // Diff — fg + background variants
  "diff.added":            "#2ee6a6",
  "diff.addedBg":          "#0f2a22", // color-mix(ok 14%, bg)
  "diff.addedBgIntra":     "#18503e", // intra-line emphasis
  "diff.removed":          "#ff5c6c",
  "diff.removedBg":        "#2a1419", // color-mix(bad 14%, bg)
  "diff.removedBgIntra":   "#542028",
  "diff.context":          "#7a93b8", // mut
  "diff.meta":             "#00d4ff", // file headers
  "diff.hunk":             "#7c5cff", // hunk @@ separators
  // Role colors (semantic aliases used by the renderer)
  "role.user":             "#7c5cff", // .nx-m
  "role.agent":            "#00d4ff", // .nx-c
  "role.agentText":        "#e6eefc", // .nx-w
  "role.tool":             "#aebfdd",
  "role.toolResult":       "#2ee6a6", // .nx-ok
  "role.system":           "#7a93b8", // .nx-g
  "role.meter":            "#7a93b8",
  "role.prompt":           "#7c5cff", // .nx-prompt
  "role.rule":             "#283a5a", // .nx-rule
};

const LIGHT = {
  "surface.base":          "#eef1f7", // --bg
  "surface.raised":        "#ffffff", // --card
  "surface.overlay":       "#f2f5fb", // --card2
  "surface.border":        "#dbe2ee", // --line
  "surface.borderSubtle":  "#e8edf5",
  "text.primary":          "#111826", // --txt
  "text.secondary":        "#3d4a63", // --txt-2
  "text.muted":            "#5b6b86", // --mut
  "text.placeholder":      "#7b8ba4", // --placeholder
  "text.inverted":         "#ffffff",
  "semantic.success":      "#087a52", // --ok (light)
  "semantic.warning":      "#8a6314", // --warn (light)
  "semantic.error":        "#c42d38", // --bad (light)
  "semantic.info":         "#1d64c4",
  "semantic.accent":       "#0575a6", // --acc (light)
  "semantic.accentAlt":    "#5a43c9", // acc-2 darkened for AA on light
  "syntax.keyword":        "#5a43c9",
  "syntax.string":         "#087a52",
  "syntax.number":         "#8a6314",
  "syntax.comment":        "#5b6b86",
  "syntax.function":       "#0575a6",
  "syntax.type":           "#1d64c4",
  "syntax.variable":       "#111826",
  "syntax.constant":       "#9a4a00",
  "syntax.operator":       "#3d4a63",
  "syntax.tag":            "#0575a6",
  "syntax.attribute":      "#8a6314",
  "syntax.punctuation":    "#5b6b86",
  "diff.added":            "#087a52",
  "diff.addedBg":          "#dff3e8",
  "diff.addedBgIntra":     "#b6e3c9",
  "diff.removed":          "#c42d38",
  "diff.removedBg":        "#fbe4e6",
  "diff.removedBgIntra":   "#f3bcc1",
  "diff.context":          "#5b6b86",
  "diff.meta":             "#0575a6",
  "diff.hunk":             "#5a43c9",
  "role.user":             "#5a43c9",
  "role.agent":            "#0575a6",
  "role.agentText":        "#111826",
  "role.tool":             "#3d4a63",
  "role.toolResult":       "#087a52",
  "role.system":           "#5b6b86",
  "role.meter":            "#5b6b86",
  "role.prompt":           "#5a43c9",
  "role.rule":             "#dbe2ee",
};

// ---------------------------------------------------------------------------
// 2. 256-color mapping table (hand-authored, NOT auto-quantised — UI-001).
//    Each token maps to a chosen xterm-256 index per background.
// ---------------------------------------------------------------------------
const MAP256_DARK = {
  "surface.base": 233, "surface.raised": 235, "surface.overlay": 237,
  "surface.border": 239, "surface.borderSubtle": 236,
  "text.primary": 255, "text.secondary": 252, "text.muted": 103,
  "text.placeholder": 60, "text.inverted": 233,
  "semantic.success": 48, "semantic.warning": 214, "semantic.error": 203,
  "semantic.info": 69, "semantic.accent": 45, "semantic.accentAlt": 99,
  "syntax.keyword": 99, "syntax.string": 48, "syntax.number": 214,
  "syntax.comment": 103, "syntax.function": 45, "syntax.type": 117,
  "syntax.variable": 255, "syntax.constant": 208, "syntax.operator": 252,
  "syntax.tag": 45, "syntax.attribute": 214, "syntax.punctuation": 103,
  "diff.added": 48, "diff.addedBg": 22, "diff.addedBgIntra": 29,
  "diff.removed": 203, "diff.removedBg": 52, "diff.removedBgIntra": 88,
  "diff.context": 103, "diff.meta": 45, "diff.hunk": 99,
  "role.user": 99, "role.agent": 45, "role.agentText": 255, "role.tool": 252,
  "role.toolResult": 48, "role.system": 103, "role.meter": 103,
  "role.prompt": 99, "role.rule": 239,
};
const MAP256_LIGHT = {
  "surface.base": 254, "surface.raised": 231, "surface.overlay": 255,
  "surface.border": 251, "surface.borderSubtle": 253,
  "text.primary": 234, "text.secondary": 240, "text.muted": 243,
  "text.placeholder": 245, "text.inverted": 231,
  "semantic.success": 29, "semantic.warning": 94, "semantic.error": 160,
  "semantic.info": 26, "semantic.accent": 31, "semantic.accentAlt": 61,
  "syntax.keyword": 61, "syntax.string": 29, "syntax.number": 94,
  "syntax.comment": 243, "syntax.function": 31, "syntax.type": 26,
  "syntax.variable": 234, "syntax.constant": 130, "syntax.operator": 240,
  "syntax.tag": 31, "syntax.attribute": 94, "syntax.punctuation": 243,
  "diff.added": 29, "diff.addedBg": 194, "diff.addedBgIntra": 151,
  "diff.removed": 160, "diff.removedBg": 224, "diff.removedBgIntra": 217,
  "diff.context": 243, "diff.meta": 31, "diff.hunk": 61,
  "role.user": 61, "role.agent": 31, "role.agentText": 234, "role.tool": 240,
  "role.toolResult": 29, "role.system": 243, "role.meter": 243,
  "role.prompt": 61, "role.rule": 251,
};

// ---------------------------------------------------------------------------
// 3. 16-color ANSI mapping (legible, not merely functional — UI-001).
//    Values are SGR fg codes (30-37 normal, 90-97 bright). Chosen per
//    background so text stays readable without painting a competing fill.
// ---------------------------------------------------------------------------
const MAP16_DARK = {
  "surface.base": 30, "surface.raised": 30, "surface.overlay": 90,
  "surface.border": 90, "surface.borderSubtle": 90,
  "text.primary": 97, "text.secondary": 37, "text.muted": 90,
  "text.placeholder": 90, "text.inverted": 30,
  "semantic.success": 92, "semantic.warning": 93, "semantic.error": 91,
  "semantic.info": 94, "semantic.accent": 96, "semantic.accentAlt": 95,
  "syntax.keyword": 95, "syntax.string": 92, "syntax.number": 93,
  "syntax.comment": 90, "syntax.function": 96, "syntax.type": 94,
  "syntax.variable": 97, "syntax.constant": 93, "syntax.operator": 37,
  "syntax.tag": 96, "syntax.attribute": 93, "syntax.punctuation": 90,
  "diff.added": 92, "diff.addedBg": 42, "diff.addedBgIntra": 42,
  "diff.removed": 91, "diff.removedBg": 41, "diff.removedBgIntra": 41,
  "diff.context": 90, "diff.meta": 96, "diff.hunk": 95,
  "role.user": 95, "role.agent": 96, "role.agentText": 97, "role.tool": 37,
  "role.toolResult": 92, "role.system": 90, "role.meter": 90,
  "role.prompt": 95, "role.rule": 90,
};
const MAP16_LIGHT = {
  "surface.base": 37, "surface.raised": 37, "surface.overlay": 37,
  "surface.border": 90, "surface.borderSubtle": 37,
  "text.primary": 30, "text.secondary": 90, "text.muted": 90,
  "text.placeholder": 90, "text.inverted": 97,
  "semantic.success": 32, "semantic.warning": 33, "semantic.error": 31,
  "semantic.info": 34, "semantic.accent": 36, "semantic.accentAlt": 35,
  "syntax.keyword": 35, "syntax.string": 32, "syntax.number": 33,
  "syntax.comment": 90, "syntax.function": 36, "syntax.type": 34,
  "syntax.variable": 30, "syntax.constant": 33, "syntax.operator": 90,
  "syntax.tag": 36, "syntax.attribute": 33, "syntax.punctuation": 90,
  "diff.added": 32, "diff.addedBg": 102, "diff.addedBgIntra": 102,
  "diff.removed": 31, "diff.removedBg": 101, "diff.removedBgIntra": 101,
  "diff.context": 90, "diff.meta": 36, "diff.hunk": 35,
  "role.user": 35, "role.agent": 36, "role.agentText": 30, "role.tool": 90,
  "role.toolResult": 32, "role.system": 90, "role.meter": 90,
  "role.prompt": 35, "role.rule": 90,
};

// ---------------------------------------------------------------------------
// 4. Border character sets (UI-003). One set per style + ASCII fallback.
// ---------------------------------------------------------------------------
const BORDERS = {
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", ml: "├", mr: "┤" },
  square:  { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", ml: "├", mr: "┤" },
  thin:    { h: "─", v: "│" },
  ascii:   { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", ml: "+", mr: "+" },
};

// ---------------------------------------------------------------------------
// 5. Spacing scale (UI-001 / UI-008). Indentation is the primary structural
//    device; 2 columns per level, matched to the web's 4px grid (2ch ≈ one step).
// ---------------------------------------------------------------------------
const SPACING = {
  indentUnit: 2,
  indent: (level = 0) => " ".repeat(Math.max(0, level) * 2),
  rhythm: 1, // blank rows between major blocks
};

// ---------------------------------------------------------------------------
// 6. Capability resolution (depth + background), pure + testable.
// ---------------------------------------------------------------------------
const DEPTH = { NONE: "none", ANSI16: "16", ANSI256: "256", TRUECOLOR: "truecolor" };

function resolveDepth(env = process.env, stream = process.stdout) {
  // NO_COLOR (https://no-color.org) and explicit opt-outs win.
  if (env.NO_COLOR != null && env.NO_COLOR !== "") return DEPTH.NONE;
  if (env.NEXUS_COLOR) {
    const v = String(env.NEXUS_COLOR).toLowerCase();
    if (v === "none" || v === "0") return DEPTH.NONE;
    if (v === "16") return DEPTH.ANSI16;
    if (v === "256") return DEPTH.ANSI256;
    if (v === "truecolor" || v === "24bit" || v === "3") return DEPTH.TRUECOLOR;
  }
  if (env.FORCE_COLOR != null) {
    const f = String(env.FORCE_COLOR);
    if (f === "0" || f === "false") return DEPTH.NONE;
    if (f === "1" || f === "true") return DEPTH.ANSI16;
    if (f === "2") return DEPTH.ANSI256;
    if (f === "3") return DEPTH.TRUECOLOR;
  }
  const isTTY = !!(stream && stream.isTTY);
  if (!isTTY) return DEPTH.NONE; // piped to file / program / CI → no color
  const term = String(env.TERM || "").toLowerCase();
  if (term === "dumb") return DEPTH.NONE;
  const colorterm = String(env.COLORTERM || "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return DEPTH.TRUECOLOR;
  if (/-256(color)?$/.test(term) || term.includes("256")) return DEPTH.ANSI256;
  // Modern terminals that report neither but do support truecolor.
  if (/^(iterm|wezterm|kitty|alacritty)/.test(String(env.TERM_PROGRAM || "").toLowerCase())) {
    return DEPTH.TRUECOLOR;
  }
  return DEPTH.ANSI16;
}

const BG = { DARK: "dark", LIGHT: "light" };

function resolveBackground(env = process.env, opts = {}) {
  if (env.NEXUS_BG) {
    const v = String(env.NEXUS_BG).toLowerCase();
    if (v === "light" || v === "dark") return v;
  }
  // COLORFGBG: "fg;bg" (sometimes "fg;;bg"). Last field is the background index.
  const cfb = env.COLORFGBG;
  if (cfb) {
    const parts = String(cfb).split(";");
    const bg = parseInt(parts[parts.length - 1], 10);
    if (!Number.isNaN(bg)) return (bg === 7 || bg >= 9) ? BG.LIGHT : BG.DARK;
  }
  return opts.default || BG.DARK; // OSC 11 is handled out-of-band; see queryBackground()
}

// Parse an OSC 11 reply (rgb:RRRR/GGGG/BBBB) into "dark" | "light" (UI-002).
function parseOSC11(reply) {
  const m = /rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})/i.exec(String(reply || ""));
  if (!m) return null;
  const norm = (h) => parseInt(h.slice(0, 2), 16);
  const r = norm(m[1]), g = norm(m[2]), b = norm(m[3]);
  // Rec. 601 luma; > ~50% → light background.
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.5 ? BG.LIGHT : BG.DARK;
}

// ---------------------------------------------------------------------------
// 7. Color math for truecolor SGR.
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ---------------------------------------------------------------------------
// 8. The Theme instance — resolves tokens → escapes for the active config.
// ---------------------------------------------------------------------------
function makeTheme(config) {
  const depth = config.depth;
  const bg = config.background;
  const palette = bg === BG.LIGHT ? LIGHT : DARK;
  const map256 = bg === BG.LIGHT ? MAP256_LIGHT : MAP256_DARK;
  const map16 = bg === BG.LIGHT ? MAP16_LIGHT : MAP16_DARK;
  const on = depth !== DEPTH.NONE;

  function fgCode(token) {
    if (!palette[token]) throw new Error("Unknown theme token: " + token);
    if (depth === DEPTH.TRUECOLOR) { const [r, g, b] = hexToRgb(palette[token]); return `38;2;${r};${g};${b}`; }
    if (depth === DEPTH.ANSI256) return `38;5;${map256[token]}`;
    return String(map16[token]); // 16-color: a single SGR fg code
  }
  function bgCode(token) {
    if (depth === DEPTH.TRUECOLOR) { const [r, g, b] = hexToRgb(palette[token]); return `48;2;${r};${g};${b}`; }
    if (depth === DEPTH.ANSI256) return `48;5;${map256[token]}`;
    const c = parseInt(map16[token], 10);
    return String(c >= 90 ? c + 10 : c + 10); // fg->bg offset (+10)
  }

  // Core paint: wrap text in fg (+ optional bg + styles), always resetting.
  function paint(text, token, o = {}) {
    if (!on) return String(text);
    const codes = [];
    if (token) codes.push(fgCode(token));
    if (o.bg) codes.push(bgCode(o.bg));
    if (o.bold) codes.push(SGR.bold);
    if (o.dim) codes.push(SGR.dim);
    if (o.italic) codes.push(SGR.italic);
    if (o.underline) codes.push(SGR.underline);
    if (o.inverse) codes.push(SGR.inverse);
    if (o.strike) codes.push(SGR.strike);
    if (!codes.length) return String(text);
    return CSI + codes.join(";") + "m" + text + control.reset;
  }

  // Style-only (no color) — survives NO_COLOR as a real distinction.
  function style(text, o = {}) {
    if (!on) return String(text);
    const codes = [];
    if (o.bold) codes.push(SGR.bold);
    if (o.dim) codes.push(SGR.dim);
    if (o.italic) codes.push(SGR.italic);
    if (o.underline) codes.push(SGR.underline);
    if (o.inverse) codes.push(SGR.inverse);
    if (!codes.length) return String(text);
    return CSI + codes.join(";") + "m" + text + control.reset;
  }

  return {
    config: Object.freeze({ ...config }),
    depth, background: bg,
    colorEnabled: on,
    unicode: config.unicode,
    motion: config.motion,
    hex: (token) => palette[token],       // raw value (for the web/desktop bridge)
    paint, style,
    fg: (token) => (on ? CSI + fgCode(token) + "m" : ""),
    bgOf: (token) => (on ? CSI + bgCode(token) + "m" : ""),
    reset: on ? control.reset : "",
    control: on ? control : withDisabledColor(control),
    borders: config.unicode ? BORDERS : { rounded: BORDERS.ascii, square: BORDERS.ascii, thin: { h: "-", v: "|" }, ascii: BORDERS.ascii },
    borderSet: (name) => (config.unicode ? (BORDERS[name] || BORDERS.rounded) : BORDERS.ascii),
    spacing: SPACING,
    tokens: Object.keys(palette),
  };
}

// When color is off we still allow cursor control for TTY redraws, but callers
// in --plain / screen-reader / non-TTY modes should avoid it entirely.
function withDisabledColor(ctrl) {
  return { ...ctrl, reset: "" };
}

// ---------------------------------------------------------------------------
// 9. Default auto-detected instance + reconfigure hook.
// ---------------------------------------------------------------------------
function autoConfig(env = process.env, stream = process.stdout) {
  return {
    depth: resolveDepth(env, stream),
    background: resolveBackground(env, { default: BG.DARK }),
    unicode: resolveUnicode(env),
    motion: resolveMotion(env, stream),
  };
}

function resolveUnicode(env = process.env) {
  if (env.NEXUS_ASCII === "1" || env.NEXUS_UNICODE === "0") return false;
  const loc = String(env.LC_ALL || env.LC_CTYPE || env.LANG || "").toLowerCase();
  if (!loc) return process.platform !== "win32"; // assume modern unix locale
  return /utf-?8/.test(loc);
}

function resolveMotion(env = process.env, stream = process.stdout) {
  if (env.NO_COLOR != null && env.NO_COLOR !== "") return false;
  if (env.NEXUS_REDUCED_MOTION === "1" || env.REDUCE_MOTION === "1") return false;
  if (env.CI) return false;
  return !!(stream && stream.isTTY);
}

let active = makeTheme(autoConfig());

module.exports = {
  // Constants / enums
  DEPTH, BG, DARK, LIGHT, BORDERS, SPACING, control, SGR, ANSI_RE, stripAnsi,
  // Pure resolvers (testable)
  resolveDepth, resolveBackground, resolveUnicode, resolveMotion, parseOSC11, autoConfig, hexToRgb,
  // Factory + default instance accessors
  makeTheme,
  get: () => active,
  configure: (overrides = {}) => { active = makeTheme({ ...active.config, ...overrides }); return active; },
  reset: () => { active = makeTheme(autoConfig()); return active; },
};
