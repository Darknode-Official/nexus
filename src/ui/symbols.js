"use strict";
// ============================================================================
// Restrained symbol set with an ASCII equivalent for every symbol (UI-008 /
// UI-010). No decorative emoji. The active set is chosen by the theme's unicode
// capability so a non-UTF-8 locale still renders a legible, aligned interface.
// Each entry is [unicode, ascii]. Widths are kept to a single column.
// ============================================================================

const SET = {
  // Role / status markers (mirror the web console's .nx-* dots)
  bullet:     ["●", "*"],   // agent / tool status dot
  userArrow:  ["›", ">"],   // user input marker ("› you")
  prompt:     [">", ">"],   // composer prompt marker
  ok:         ["✓", "+"],   // success (duplicates the success color for NO_COLOR)
  fail:       ["✗", "x"],   // failure
  warn:       ["!", "!"],   // warning
  info:       ["i", "i"],   // info
  pending:    ["○", "o"],   // not started
  running:    ["◐", "~"],   // in progress (static fallback for spinner)
  skipped:    ["–", "-"],   // skipped
  arrowR:     ["→", "->"],
  arrowL:     ["←", "<-"],
  ellipsis:   ["…", "..."],
  // Structure
  treeMid:    ["├─", "|-"],
  treeEnd:    ["└─", "`-"],
  treeBar:    ["│ ", "|  "],
  dot:        ["·", "."],    // separator in meter lines
  bar:        ["─", "-"],    // thin rule glyph
  // Meters (context / progress)
  meterFull:  ["▓", "#"],
  meterEmpty: ["░", "."],
  // Diff gutters
  diffAdd:    ["+", "+"],
  diffDel:    ["-", "-"],
  diffCtx:    [" ", " "],
  // Collapse / expand affordances (tool output — UI-005)
  collapsed:  ["▸", ">"],
  expanded:   ["▾", "v"],
  // Interrupt / attention
  interrupt:  ["■", "#"],
};

// Spinner frame vocabularies (UI-007). Braille is the primary; ascii is the
// reduced / non-unicode fallback. A static indicator is used for reduced-motion.
const SPINNERS = {
  braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  line:    ["-", "\\", "|", "/"],
  static:  "●",
  staticAscii: "*",
};

function make(unicode) {
  const out = {};
  for (const [k, pair] of Object.entries(SET)) out[k] = unicode ? pair[0] : pair[1];
  out._unicode = unicode;
  out.spinnerFrames = unicode ? SPINNERS.braille : SPINNERS.line;
  out.spinnerStatic = unicode ? SPINNERS.static : SPINNERS.staticAscii;
  return out;
}

module.exports = { SET, SPINNERS, make };
