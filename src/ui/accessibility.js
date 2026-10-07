"use strict";
// ============================================================================
// Accessibility and degradation (UI-010).
//   • --plain  : clean, parseable, diffable output (no color, no cursor tricks).
//   • screen-reader mode: linear output, no redraw, no cursor gymnastics.
//   • errors that state what happened, what the agent was doing, and what to do.
// Every color distinction is already duplicated by a symbol/label in the theme
// and renderer; this module wires the flags and the error format.
// ============================================================================

const themeMod = require("./theme");
const symbolsMod = require("./symbols");
const { wrap } = require("./width");

// Resolve runtime accessibility flags from argv + env.
function resolveFlags(argv = process.argv, env = process.env) {
  const has = (f) => argv.includes(f);
  const plain = has("--plain") || env.NEXUS_PLAIN === "1";
  const screenReader = has("--screen-reader") || env.NEXUS_SCREEN_READER === "1" || env.NEXUS_A11Y === "1";
  return { plain, screenReader };
}

// Apply flags to the active theme. --plain and screen-reader force no color and
// (for the host) no transient redraws / no spinner animation.
function apply(flags = resolveFlags()) {
  if (flags.plain || flags.screenReader) {
    themeMod.configure({ depth: themeMod.DEPTH.NONE, motion: false });
  }
  return flags;
}

// Structured error block (UI-010): what happened · what we were doing · next.
// spec: { message, during, next:[], code }
function errorBlock(spec, opts = {}, theme) {
  const t = theme || themeMod.get();
  const s = symbolsMod.make(t.unicode);
  const width = opts.width || 80;
  const out = [];
  const head = t.paint(s.fail + " error", "semantic.error", { bold: true }) +
    (spec.code ? t.paint("  [" + spec.code + "]", "role.system") : "");
  out.push(head);
  for (const ln of wrap(spec.message || "Something went wrong.", width - 2)) out.push("  " + t.paint(ln, "text.primary"));
  if (spec.during) {
    out.push("  " + t.paint("while: ", "text.muted", { bold: true }) + t.paint(spec.during, "text.secondary"));
  }
  if (spec.next && spec.next.length) {
    out.push("  " + t.paint("try:", "text.muted", { bold: true }));
    for (const n of spec.next) out.push("    " + t.paint(s.arrowR, "semantic.accent") + " " + t.paint(n, "text.secondary"));
  }
  return out.join("\n");
}

module.exports = { resolveFlags, apply, errorBlock };
