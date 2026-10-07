"use strict";
// ============================================================================
// The composer (UI-004) — the Claude Code–style rounded input box, the surface
// the user looks at most and the anchor of the design. It is RETAINED, not
// replaced. This module provides:
//   • ComposerModel — a pure line-editing state machine (word movement, kill
//     line, history with partial-line preservation, history search, paste).
//   • renderComposer() — a deterministic renderer: rounded box anchored at the
//     bottom, grows upward as input wraps, max height then internal scroll,
//     a quiet prompt marker, a status line (engine+model · cost meter · mode),
//     and a distinct working-vs-awaiting visual state.
//   • renderCompletion() — a non-destructive overlay drawn ABOVE the composer.
//   • history persistence scoped per project.
// The live key loop lives in the host (darknode-cli); it drives this model and
// prints these frames. Everything here is pure + snapshot-testable.
// ============================================================================

const themeMod = require("./theme");
const symbolsMod = require("./symbols");
const { stringWidth, truncate, pad, wrap } = require("./width");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Editing model — pure state; the host maps keys to these methods.
// ---------------------------------------------------------------------------
class ComposerModel {
  constructor(opts = {}) {
    this.text = opts.text || "";   // full buffer (may contain \n)
    this.cursor = this.text.length; // index into text
    this.history = opts.history || [];
    this.histIndex = this.history.length; // points past the end = current draft
    this.draft = "";               // partially typed line preserved during history nav
    this.searchMode = false;
    this.searchQuery = "";
    this.maxRows = opts.maxRows || 10;
  }

  insert(str) {
    this.text = this.text.slice(0, this.cursor) + str + this.text.slice(this.cursor);
    this.cursor += str.length;
  }
  newline() { this.insert("\n"); }              // the defined chord (e.g. shift+enter / alt+enter)
  backspace() { if (this.cursor > 0) { this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor); this.cursor--; } }
  deleteForward() { if (this.cursor < this.text.length) this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1); }

  left() { if (this.cursor > 0) this.cursor--; }
  right() { if (this.cursor < this.text.length) this.cursor++; }
  home() { const nl = this.text.lastIndexOf("\n", this.cursor - 1); this.cursor = nl + 1; }
  end() { const nl = this.text.indexOf("\n", this.cursor); this.cursor = nl === -1 ? this.text.length : nl; }

  wordLeft() {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.text[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.text[i - 1])) i--;
    this.cursor = i;
  }
  wordRight() {
    let i = this.cursor;
    while (i < this.text.length && /\s/.test(this.text[i])) i++;
    while (i < this.text.length && !/\s/.test(this.text[i])) i++;
    this.cursor = i;
  }
  deleteWordLeft() { const end = this.cursor; this.wordLeft(); this.text = this.text.slice(0, this.cursor) + this.text.slice(end); }
  killToEnd() { const eol = this.text.indexOf("\n", this.cursor); const stop = eol === -1 ? this.text.length : eol; this.text = this.text.slice(0, this.cursor) + this.text.slice(stop); }

  historyPrev() {
    if (!this.history.length) return;
    if (this.histIndex === this.history.length) this.draft = this.text; // preserve partial line
    if (this.histIndex > 0) this.histIndex--;
    this.text = this.history[this.histIndex] || "";
    this.cursor = this.text.length;
  }
  historyNext() {
    if (this.histIndex >= this.history.length) return;
    this.histIndex++;
    this.text = this.histIndex === this.history.length ? this.draft : (this.history[this.histIndex] || "");
    this.cursor = this.text.length;
  }

  startSearch() { this.searchMode = true; this.searchQuery = ""; }
  updateSearch(q) {
    this.searchQuery = q;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].includes(q)) { this.text = this.history[i]; this.cursor = this.text.length; break; }
    }
  }
  endSearch() { this.searchMode = false; this.searchQuery = ""; }

  // Bracketed paste: a large paste collapses to a summary line (UI-004).
  paste(str, opts = {}) {
    const threshold = opts.collapseOver || 800;
    const lines = str.split("\n").length;
    if (str.length > threshold || lines > 20) {
      this.pasted = (this.pasted || []);
      this.pasted.push(str);
      this.insert(`[pasted ${lines} lines, ${str.length} chars #${this.pasted.length}]`);
      return { collapsed: true, lines, chars: str.length };
    }
    this.insert(str);
    return { collapsed: false };
  }

  submit() {
    const value = this.text;
    if (value.trim()) { this.history.push(value); }
    this.text = ""; this.cursor = 0; this.histIndex = this.history.length; this.draft = "";
    return value;
  }
}

// ---------------------------------------------------------------------------
// Renderer — the rounded box + status line. Deterministic (snapshot-friendly).
// state: { text, working, status } — status: { engine, model, ctxPct, up, down,
//         cost, mode, hint }
// ---------------------------------------------------------------------------
function renderComposer(state, opts = {}, theme) {
  const t = theme || themeMod.get();
  const s = symbolsMod.make(t.unicode);
  const width = opts.width || 80;
  const b = t.borderSet("rounded");
  const working = !!state.working;
  // The frame signals state: accent border + "working" cue vs. quiet awaiting.
  const borderToken = working ? "semantic.accent" : "surface.border";
  const prompt = t.paint(s.prompt, "role.prompt", { bold: true });
  const inner = Math.max(10, width - 4); // 2 border + 1 pad each side
  const maxRows = opts.maxRows || state.maxRows || 10;

  // Wrap the buffer to the inner width, preserving word boundaries. An empty
  // buffer shows a quiet placeholder.
  const text = state.text != null ? state.text : (state.model ? state.model.text : "");
  let rows;
  if (!text) {
    rows = [t.paint(opts.placeholder || "Ask Nexus, or / for commands", "text.placeholder")];
  } else {
    rows = [];
    for (const para of text.split("\n")) rows.push(...(para === "" ? [""] : wrap(para, inner)));
  }

  // Grow upward until maxRows, then internal scroll: keep the last rows and a
  // "more above" indicator so the cursor line stays visible (UI-004).
  let scrolled = false;
  if (rows.length > maxRows) { rows = rows.slice(rows.length - maxRows); scrolled = true; }

  const out = [];
  out.push(t.paint(b.tl + b.h.repeat(width - 2) + b.tr, borderToken));
  rows.forEach((row, idx) => {
    const marker = idx === 0 ? prompt + " " : "  ";
    const content = pad(truncate(row, inner), inner);
    out.push(t.paint(b.v, borderToken) + " " + marker + content + " " + t.paint(b.v, borderToken));
  });
  out.push(t.paint(b.bl + b.h.repeat(width - 2) + b.br, borderToken));

  // Status line below the box (UI-004): engine+model · ctx meter · tokens · cost · mode.
  out.push(renderStatusLine(state.status || {}, { width, working, scrolled }, t));
  return out.join("\n");
}

function renderStatusLine(status, opts, theme) {
  const t = theme || themeMod.get();
  const s = symbolsMod.make(t.unicode);
  const sep = " " + t.paint(s.dot, "role.rule") + " ";
  const parts = [];
  if (opts.working) parts.push(t.paint(s.running + " working (esc to interrupt)", "semantic.accent", { bold: true }));
  if (status.model) parts.push(t.paint(status.model, "semantic.accent"));
  else if (status.engine) parts.push(t.paint(status.engine, "semantic.accent"));
  if (status.ctxPct != null) parts.push(t.paint("ctx " + status.ctxPct + "%", "role.meter") + " " + ctxMeter(status.ctxPct, t, s));
  if (status.up != null || status.down != null) parts.push(t.paint("↑" + fmtTok(status.up) + " ↓" + fmtTok(status.down) + " tok", "role.meter"));
  if (status.cost != null) parts.push(t.paint("$" + Number(status.cost).toFixed(2), "role.toolResult"));
  if (status.mode) parts.push(t.paint(status.mode, "semantic.success"));
  if (opts.scrolled) parts.push(t.paint("↑ more", "role.system"));
  return "  " + parts.join(sep);
}

function ctxMeter(pct, theme, s) {
  const slots = 8;
  const filled = Math.round((pct / 100) * slots);
  const bar = s.meterFull.repeat(filled) + s.meterEmpty.repeat(slots - filled);
  const token = pct > 85 ? "semantic.error" : pct > 60 ? "semantic.warning" : "role.meter";
  return theme.paint(bar, token);
}
function fmtTok(n) { if (n == null) return "0"; return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n); }

// ---------------------------------------------------------------------------
// Completion overlay (UI-004) — drawn ABOVE the composer, non-destructive.
// The host prints this, then the composer; on dismiss it redraws without it so
// scrollback is never corrupted. items: [{label, hint, kind}]
// ---------------------------------------------------------------------------
function renderCompletion(items, selected, opts = {}, theme) {
  const t = theme || themeMod.get();
  const s = symbolsMod.make(t.unicode);
  const width = opts.width || 80;
  const b = t.borderSet("square");
  const max = opts.maxItems || 8;
  const shown = items.slice(0, max);
  const labelW = Math.min(28, Math.max(...shown.map((it) => stringWidth(it.label)), 4));
  const inner = Math.max(10, width - 4);
  const out = [];
  out.push(t.paint(b.tl + b.h.repeat(width - 2) + b.tr, "surface.border"));
  shown.forEach((it, i) => {
    const sel = i === selected;
    const mark = sel ? t.paint(s.arrowR, "semantic.accent", { bold: true }) : " ";
    const label = t.paint(pad(it.label, labelW), sel ? "semantic.accent" : "text.primary", { bold: sel });
    const hint = it.hint ? t.paint(truncate(it.hint, inner - labelW - 3), "role.system") : "";
    const row = pad(mark + " " + label + " " + hint, inner);
    out.push(t.paint(b.v, "surface.border") + " " + row + " " + t.paint(b.v, "surface.border"));
  });
  if (items.length > max) {
    const more = pad(t.paint("  … " + (items.length - max) + " more", "role.system"), inner);
    out.push(t.paint(b.v, "surface.border") + " " + more + " " + t.paint(b.v, "surface.border"));
  }
  out.push(t.paint(b.bl + b.h.repeat(width - 2) + b.br, "surface.border"));
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Persistent history scoped per project (UI-004).
// ---------------------------------------------------------------------------
function historyPath(projectDir = process.cwd()) {
  const hash = crypto.createHash("sha1").update(path.resolve(projectDir)).digest("hex").slice(0, 16);
  return path.join(os.homedir(), ".nexus", "history", hash + ".jsonl");
}
function loadHistory(projectDir, limit = 1000) {
  try {
    const p = historyPath(projectDir);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l).text; } catch { return l; }
    }).slice(-limit);
  } catch { return []; }
}
function appendHistory(entry, projectDir) {
  try {
    const p = historyPath(projectDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ text: entry, ts: Date.now() }) + "\n");
  } catch { /* history is best-effort */ }
}

module.exports = {
  ComposerModel, renderComposer, renderStatusLine, renderCompletion,
  historyPath, loadHistory, appendHistory,
};
