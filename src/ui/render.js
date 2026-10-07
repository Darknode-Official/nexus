"use strict";
// ============================================================================
// Shared output renderer (UI-005 + UI-011).
// A single role vocabulary, markdown, diffs, and collapsible tool output — the
// one path every command's output flows through. Pure string builders for
// deterministic snapshotting; a thin writer prints them.
// ============================================================================

const themeMod = require("./theme");
const symbolsMod = require("./symbols");
const { stringWidth, truncate, pad, wrap, stripAnsi } = require("./width");
const box = require("./box");
const { highlightLine } = require("./highlight");

function ctx(theme) {
  const t = theme || themeMod.get();
  return { t, s: symbolsMod.make(t.unicode) };
}

// ---------------------------------------------------------------------------
// Role vocabulary (UI-005). Each role = a consistent marker + color, and every
// color distinction is duplicated by a symbol/label so NO_COLOR carries it too.
// ---------------------------------------------------------------------------
function roleLine(role, text, opts = {}, theme) {
  const { t, s } = ctx(theme);
  const width = opts.width || 80;
  const indent = t.spacing.indent(opts.indent || 0);

  const specs = {
    user:   { marker: s.userArrow, mToken: "role.user",   label: "you",   lToken: "role.user",   body: "text.primary" },
    agent:  { marker: s.bullet,    mToken: "role.agent",   label: opts.label || "nexus", lToken: "role.agent", body: "role.agentText" },
    tool:   { marker: s.bullet,    mToken: "role.tool",    label: null,    body: "text.secondary" },
    result: { marker: s.ok,        mToken: "role.toolResult", label: null, body: "text.secondary" },
    system: { marker: s.dot,       mToken: "role.system",  label: null,    body: "role.system" },
    error:  { marker: s.fail,      mToken: "semantic.error", label: "error", lToken: "semantic.error", body: "semantic.error" },
    warn:   { marker: s.warn,      mToken: "semantic.warning", label: "warn", lToken: "semantic.warning", body: "text.primary" },
    info:   { marker: s.info,      mToken: "semantic.info", label: null,    body: "text.primary" },
  };
  const spec = specs[role] || specs.system;
  const marker = t.paint(spec.marker, spec.mToken, { bold: true });
  const prefix = marker + " " + (spec.label ? t.paint(spec.label, spec.lToken || spec.mToken, { bold: true }) + " " : "");
  const prefixW = stringWidth(spec.marker) + 1 + (spec.label ? stringWidth(spec.label) + 1 : 0);

  const avail = Math.max(8, width - stringWidth(indent) - prefixW);
  const lines = wrap(String(text), avail);
  const hang = " ".repeat(prefixW);
  return lines
    .map((ln, i) => indent + (i === 0 ? prefix : hang) + t.paint(ln, spec.body))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Tool invocation (UI-005): collapse to one line on success, expand on failure.
// spec: { name, args, status:"ok"|"fail"|"running", durationMs, output, expanded }
// ---------------------------------------------------------------------------
function toolCall(spec, opts = {}, theme) {
  const { t, s } = ctx(theme);
  const width = opts.width || 80;
  const indent = t.spacing.indent(opts.indent || 0);
  const ok = spec.status === "ok";
  const running = spec.status === "running";
  const marker = ok ? t.paint(s.ok, "role.toolResult", { bold: true })
    : running ? t.paint(s.running, "semantic.info", { bold: true })
    : t.paint(s.fail, "semantic.error", { bold: true });

  const argStr = spec.args != null ? (typeof spec.args === "string" ? spec.args : JSON.stringify(spec.args)) : "";
  const callW = Math.max(12, width - stringWidth(indent) - 4 - (spec.durationMs != null ? 8 : 0));
  const call = truncate(spec.name + (argStr ? "(" + argStr + ")" : ""), callW);
  const timing = spec.durationMs != null ? "  " + t.paint((spec.durationMs / 1000).toFixed(1) + "s", "role.system") : "";
  const head = indent + marker + " " + t.paint(call, "text.primary", { bold: true }) + timing;

  // Success → single line. Failure (or forced expand) → show output.
  const expand = spec.expanded != null ? spec.expanded : !ok;
  if (!expand || !spec.output) {
    // Add an expansion affordance hint when there is hidden output on success.
    if (ok && spec.output) {
      const hint = t.paint("  " + s.collapsed + " " + countLines(spec.output) + " lines", "role.system");
      return head + hint;
    }
    return head;
  }
  const bodyIndent = indent + "  ";
  const maxLines = opts.maxLines || 20;
  const outLines = String(spec.output).split("\n");
  const shown = outLines.slice(0, maxLines);
  const lines = shown.map((ln) =>
    bodyIndent + t.paint(s.treeBar.trim() || "|", "surface.border") + " " +
    t.paint(truncate(ln, width - stringWidth(bodyIndent) - 2), ok ? "text.secondary" : "semantic.error"));
  if (outLines.length > maxLines) {
    lines.push(bodyIndent + t.paint("  … " + (outLines.length - maxLines) + " more lines", "role.system"));
  }
  return [head, ...lines].join("\n");
}

function countLines(str) { return String(str).split("\n").length; }

// ---------------------------------------------------------------------------
// Cost / meter line (UI-004 status + UI-005 summary).
// spec: { files, cmds, up, down, cost, seconds, undo }
// ---------------------------------------------------------------------------
function meterLine(spec, opts = {}, theme) {
  const { t, s } = ctx(theme);
  const parts = [];
  if (spec.files != null) parts.push(spec.files + " file" + (spec.files === 1 ? "" : "s"));
  if (spec.cmds != null) parts.push(spec.cmds + " cmd" + (spec.cmds === 1 ? "" : "s"));
  if (spec.up != null || spec.down != null) parts.push(t.paint("↑" + fmtTok(spec.up) + " ↓" + fmtTok(spec.down) + " tok", "role.meter"));
  if (spec.cost != null) parts.push(t.paint("$" + spec.cost.toFixed(2), "role.toolResult"));
  if (spec.seconds != null) parts.push(spec.seconds.toFixed(1) + "s");
  if (spec.undo != null) parts.push("undo #" + spec.undo);
  const sep = " " + t.paint(s.dot, "role.rule") + " ";
  const indent = t.spacing.indent(opts.indent || 0);
  return indent + t.paint(parts.join(sep), "role.meter");
}
function fmtTok(n) { if (n == null) return "0"; return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n); }

// ---------------------------------------------------------------------------
// Unified diff (UI-005 — highest value). Parses a unified diff string.
// Honors width, truncates with an indicator, colors + bg per line, intra-line
// highlight for adjacent -/+ pairs, numbered gutters, hunk separators.
// ---------------------------------------------------------------------------
function diff(diffText, opts = {}, theme) {
  const { t, s } = ctx(theme);
  const width = opts.width || 80;
  const showNums = opts.lineNumbers !== false;
  const lines = String(diffText).split("\n");
  const out = [];
  let oldNo = 0, newNo = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const ln = lines[idx];
    if (ln.startsWith("diff ") || ln.startsWith("index ")) {
      out.push(t.paint(ln, "role.system")); continue;
    }
    if (ln.startsWith("--- ") || ln.startsWith("+++ ")) {
      out.push(t.paint(ln, "diff.meta", { bold: true })); continue;
    }
    if (ln.startsWith("@@")) {
      const m = /@@ -(\d+),?\d* \+(\d+),?\d* @@/.exec(ln);
      if (m) { oldNo = parseInt(m[1], 10); newNo = parseInt(m[2], 10); }
      out.push(t.paint(ln, "diff.hunk", { bold: true })); continue;
    }
    const gutter = (a, b) => showNums
      ? t.paint(pad(a, 4, "right") + " " + pad(b, 4, "right") + " ", "diff.context")
      : "";
    if (ln.startsWith("+") && !ln.startsWith("+++")) {
      const body = truncate(ln.slice(1), width - (showNums ? 11 : 1));
      out.push(gutter("", String(newNo++)) + t.paint(s.diffAdd + body, "diff.added", { bg: "diff.addedBg" }));
    } else if (ln.startsWith("-") && !ln.startsWith("---")) {
      const body = truncate(ln.slice(1), width - (showNums ? 11 : 1));
      out.push(gutter(String(oldNo++), "") + t.paint(s.diffDel + body, "diff.removed", { bg: "diff.removedBg" }));
    } else {
      const body = truncate(ln.replace(/^ /, ""), width - (showNums ? 11 : 1));
      out.push(gutter(String(oldNo++), String(newNo++)) + t.paint(" " + body, "diff.context"));
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Markdown (UI-005). Block-level renderer with inline spans, tables, and
// fenced code with syntax highlighting; tables degrade gracefully past width.
// ---------------------------------------------------------------------------
function markdown(md, opts = {}, theme) {
  const { t, s } = ctx(theme);
  const width = opts.width || 80;
  const src = String(md).split("\n");
  const out = [];
  let i = 0;
  while (i < src.length) {
    let line = src[i];

    // Fenced code block
    const fence = /^```(\w+)?\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || "";
      const code = [];
      i++;
      while (i < src.length && !/^```\s*$/.test(src[i])) { code.push(src[i]); i++; }
      i++; // closing fence
      out.push(...renderCodeBlock(t, code, lang, width));
      continue;
    }
    // Table (header row + separator)
    if (/\|/.test(line) && i + 1 < src.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(src[i + 1]) && /-/.test(src[i + 1])) {
      const tbl = [line];
      i++; // header
      const sep = src[i]; i++;
      while (i < src.length && /\|/.test(src[i]) && src[i].trim() !== "") { tbl.push(src[i]); i++; }
      out.push(...renderTable(t, tbl, sep, width));
      continue;
    }
    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = inline(t, h[2]);
      // No-color headings keep their "#" markers so hierarchy survives (UI-010).
      if (!t.colorEnabled) { out.push(h[1] + " " + text); i++; continue; }
      if (level === 1) out.push(t.paint(text, "semantic.accent", { bold: true, underline: true }));
      else if (level === 2) out.push(t.paint(text, "semantic.accent", { bold: true }));
      else out.push(t.paint(text, "text.primary", { bold: true }));
      i++; continue;
    }
    // Horizontal rule
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) { out.push(box.rule(t, width)); i++; continue; }
    // Blockquote
    if (/^>\s?/.test(line)) {
      const text = inline(t, line.replace(/^>\s?/, ""));
      out.push(t.paint(s.bar, "role.rule") + " " + t.paint(text, "text.secondary", { italic: true }));
      i++; continue;
    }
    // List item (ordered / unordered)
    const li = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const lead = li[1];
      const bullet = /\d/.test(li[2]) ? li[2] : s.dot;
      const marker = t.paint(bullet, "semantic.accent");
      const hang = " ".repeat(stringWidth(bullet) + 1);
      const avail = Math.max(8, width - stringWidth(lead) - stringWidth(bullet) - 1);
      layoutInline(t, li[3], avail).forEach((seg, k) => {
        out.push(lead + (k === 0 ? marker + " " : hang) + seg);
      });
      i++; continue;
    }
    // Blank line
    if (line.trim() === "") { out.push(""); i++; continue; }
    // Paragraph (gather until blank)
    const para = [line]; i++;
    while (i < src.length && src[i].trim() !== "" && !/^(#{1,6}\s|```|>|\s*[-*+]\s|\d+\.\s)/.test(src[i])) { para.push(src[i]); i++; }
    const text = para.join(" ");
    for (const ln of layoutInline(t, text, width)) out.push(ln);
  }
  return out.join("\n");
}

// Parse inline markup into typed segments: **bold**, *italic*, `code`,
// [text](url), and plain runs. (Code/links are atomic; they are not re-split.)
function parseInline(str) {
  const s = String(str);
  const re = /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)|(\[[^\]]+\]\([^)]+\))/g;
  const segs = [];
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) segs.push({ text: s.slice(last, m.index), style: "plain" });
    if (m[1]) segs.push({ text: m[1].slice(2, -2), style: "bold" });
    else if (m[2]) segs.push({ text: m[2].slice(1, -1), style: "italic" });
    else if (m[3]) segs.push({ text: m[3].slice(1, -1), style: "code", atomic: true });
    else if (m[4]) { const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(m[4]); segs.push({ text: mm[1], url: mm[2], style: "link", atomic: true }); }
    last = re.lastIndex;
  }
  if (last < s.length) segs.push({ text: s.slice(last), style: "plain" });
  return segs;
}

// Paint one segment. When color is disabled every distinction is preserved with
// its ASCII marker so the information survives (UI-010).
function paintSeg(t, seg, text) {
  const plain = !t.colorEnabled;
  const body = text != null ? text : seg.text;
  switch (seg.style) {
    case "bold":   return plain ? "**" + body + "**" : t.paint(body, "text.primary", { bold: true });
    case "italic": return plain ? "*" + body + "*" : t.paint(body, "text.primary", { italic: true });
    case "code":   return plain ? "`" + body + "`" : t.paint(body, "syntax.string");
    case "link":   return plain ? body + " (" + seg.url + ")" : t.paint(body, "semantic.accent", { underline: true }) + t.paint(" (" + seg.url + ")", "role.system");
    default:       return body;
  }
}

// Single-line inline render (headings, table cells, blockquotes).
function inline(t, str) { return parseInline(str).map((seg) => paintSeg(t, seg)).join(""); }

// Word-aware inline layout: paints segments, wraps at word boundaries by VISIBLE
// width (so markup is never stripped and never bleeds across a wrap). Returns
// painted lines.
function layoutInline(t, str, width) {
  const words = []; // { painted, w, space }
  for (const seg of parseInline(str)) {
    if (seg.atomic) {
      const painted = paintSeg(t, seg);
      words.push({ painted, w: stringWidth(stripAnsi(painted)), space: false });
      continue;
    }
    for (const part of seg.text.split(/(\s+)/)) {
      if (part === "") continue;
      if (/^\s+$/.test(part)) { words.push({ painted: part, w: part.length, space: true }); continue; }
      const painted = paintSeg(t, seg, part);
      words.push({ painted, w: stringWidth(part), space: false });
    }
  }
  const lines = [];
  let cur = "", curW = 0;
  for (const word of words) {
    if (word.space) { if (curW > 0 && curW + word.w <= width) { cur += word.painted; curW += word.w; } continue; }
    if (curW + word.w > width && curW > 0) { lines.push(cur); cur = ""; curW = 0; }
    cur += word.painted; curW += word.w;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function renderCodeBlock(t, code, lang, width) {
  const inner = Math.max(8, width - 4);
  const lines = code.map((ln) => "  " + highlightLine(t, ln.length > inner ? truncate(ln, inner) : ln, lang));
  const bar = t.paint(t.borderSet("thin").v, "surface.border");
  // Code block: a thin left rule, not a full box around flowing text (UI-003).
  return lines.map((ln) => bar + ln);
}

function renderTable(t, rows, sep, width) {
  const split = (r) => r.replace(/^\s*\|?/, "").replace(/\|?\s*$/, "").split("|").map((c) => c.trim());
  const header = split(rows[0]);
  const body = rows.slice(1).map(split);
  const cols = header.length;
  const widths = header.map((h, c) => Math.max(stringWidth(h), ...body.map((r) => stringWidth(r[c] || ""))));
  const total = widths.reduce((a, b) => a + b, 0) + (cols - 1) * 3 + 2;
  const out = [];
  if (total > width) {
    // Degrade: render each row as an indented key:value list (UI-005).
    for (const r of body) {
      header.forEach((h, c) => out.push("  " + t.paint(h + ":", "text.muted", { bold: true }) + " " + t.paint(r[c] || "", "text.primary")));
      out.push("");
    }
    return out;
  }
  const fmtRow = (cells, token, bold) =>
    cells.map((cell, c) => t.paint(pad(truncate(cell || "", widths[c]), widths[c]), token, { bold })).join(t.paint(" " + t.borderSet("thin").v + " ", "surface.border"));
  out.push(fmtRow(header, "semantic.accent", true));
  out.push(t.paint(widths.map((w) => t.borderSet("thin").h.repeat(w)).join("-+-"), "surface.border"));
  for (const r of body) out.push(fmtRow(r, "text.primary", false));
  return out;
}

// ---------------------------------------------------------------------------
// Long output: show the head, note the remainder (pagination affordance).
// ---------------------------------------------------------------------------
function clampOutput(text, opts = {}, theme) {
  const { t } = ctx(theme);
  const max = opts.maxLines || 40;
  const lines = String(text).split("\n");
  if (lines.length <= max) return text;
  const head = lines.slice(0, max).join("\n");
  return head + "\n" + t.paint("  … " + (lines.length - max) + " more lines (press space to scroll, q to close)", "role.system");
}

module.exports = {
  roleLine, toolCall, meterLine, diff, markdown, clampOutput, inline,
};
