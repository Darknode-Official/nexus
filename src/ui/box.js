"use strict";
// ============================================================================
// Borders, rules, box vocabulary (UI-003).
// One border style set: rounded (primary — composer, panels that take input or
// demand attention), square (nested/secondary frames), thin rules (separation).
// ASCII fallback when the terminal/locale can't render box-drawing.
// Used sparingly BY DESIGN: never box flowing output text — reserve frames for
// surfaces that take input or demand attention; use whitespace + color otherwise.
// ============================================================================

const { stringWidth, truncate, pad, wrap } = require("./width");

// A horizontal rule spanning `width` columns, painted in the rule token.
function rule(theme, width, opts = {}) {
  const ch = theme.borderSet("thin").h;
  const line = ch.repeat(Math.max(0, width));
  return theme.paint(line, opts.token || "role.rule");
}

// A labelled thin rule: "── label ──────────" (section separator, UI-005).
function labeledRule(theme, label, width, opts = {}) {
  const ch = theme.borderSet("thin").h;
  const lead = ch.repeat(2) + " ";
  const text = theme.paint(label, opts.labelToken || "text.muted", { bold: true });
  const used = 3 + stringWidth(label) + 1;
  const tail = " " + ch.repeat(Math.max(0, width - used));
  return theme.paint(lead, "role.rule") + text + theme.paint(tail, "role.rule");
}

// Render a bordered panel around pre-wrapped content lines.
// opts: { style:"rounded"|"square", width, title, titleToken, borderToken,
//         padX (default 1), accent (token for an attention frame) }
// Content lines are padded to the inner width; over-wide lines are truncated.
function panel(theme, contentLines, opts = {}) {
  const style = opts.style || "rounded";
  const b = theme.borderSet(style);
  const borderToken = opts.borderToken || "surface.border";
  const padX = opts.padX == null ? 1 : opts.padX;
  const inner = Math.max(1, (opts.width || 80) - 2 - padX * 2);
  const padStr = " ".repeat(padX);
  const out = [];

  // Top border, optionally with an inline title.
  let top;
  if (opts.title) {
    const title = truncate(" " + opts.title + " ", inner);
    const tW = stringWidth(title);
    const fill = b.h.repeat(Math.max(0, inner + padX * 2 - tW - 1));
    // The title text is painted in its own token, not the border color.
    top = theme.paint(b.tl + b.h, borderToken) +
          theme.paint(title, opts.titleToken || "text.primary", { bold: true }) +
          theme.paint(fill + b.tr, borderToken);
  } else {
    top = theme.paint(b.tl + b.h.repeat(inner + padX * 2) + b.tr, borderToken);
  }
  out.push(top);

  for (const raw of contentLines) {
    const line = truncate(raw, inner);
    const body = padStr + pad(line, inner) + padStr;
    out.push(theme.paint(b.v, borderToken) + body + theme.paint(b.v, borderToken));
  }

  out.push(theme.paint(b.bl + b.h.repeat(inner + padX * 2) + b.br, borderToken));
  return out.join("\n");
}

// Convenience: wrap raw text into a panel at the given width.
function textPanel(theme, text, opts = {}) {
  const padX = opts.padX == null ? 1 : opts.padX;
  const inner = Math.max(1, (opts.width || 80) - 2 - padX * 2);
  const lines = wrap(text, inner);
  return panel(theme, lines, opts);
}

module.exports = { rule, labeledRule, panel, textPanel };
