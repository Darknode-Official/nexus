"use strict";
// ============================================================================
// Plan, progress, and the agent loop (UI-006).
// Step lists with per-step state, progress with elapsed + projection, parallel
// multi-agent tracks that stay attributable, and confirmation prompts that are
// impossible to miss — with a destructive prompt visibly distinct from a
// routine one. Every status is carried by a symbol + label, not color alone.
// ============================================================================

const themeMod = require("./theme");
const symbolsMod = require("./symbols");
const { stringWidth, truncate, pad } = require("./width");
const box = require("./box");

function ctx(theme) { const t = theme || themeMod.get(); return { t, s: symbolsMod.make(t.unicode) }; }

// Per-step state → marker + token. Symbol carries the state under NO_COLOR.
function stepGlyph(state, s) {
  switch (state) {
    case "done":    return { sym: s.ok,      token: "semantic.success", label: "done" };
    case "running": return { sym: s.running, token: "semantic.accent",  label: "running" };
    case "failed":  return { sym: s.fail,    token: "semantic.error",   label: "failed" };
    case "skipped": return { sym: s.skipped, token: "text.muted",       label: "skipped" };
    default:        return { sym: s.pending, token: "text.muted",       label: "pending" };
  }
}

// Render a plan as a numbered step list. steps: [{ title, state }]
// opts: { width, current } — current index is drawn unambiguously.
function plan(steps, opts = {}, theme) {
  const { t, s } = ctx(theme);
  const width = opts.width || 80;
  const out = [];
  out.push(box.labeledRule(t, "plan", width));
  steps.forEach((step, idx) => {
    const g = stepGlyph(step.state, s);
    const isCurrent = step.state === "running" || idx === opts.current;
    const marker = t.paint(g.sym, g.token, { bold: true });
    const num = t.paint(pad(String(idx + 1), 2, "right") + ".", "role.system");
    const titleToken = isCurrent ? "text.primary" : (step.state === "done" ? "text.secondary" : "text.muted");
    const pointer = isCurrent ? t.paint(s.arrowR + " ", "semantic.accent", { bold: true }) : "  ";
    const avail = Math.max(10, width - 10);
    const title = t.paint(truncate(step.title, avail), titleToken, { bold: isCurrent, strike: step.state === "skipped" });
    out.push(pointer + marker + " " + num + " " + title);
  });
  return out.join("\n");
}

// Progress for a long op: elapsed + projected remaining where estimable.
// spec: { label, done, total, startedAt } — ETA only when total+rate are real.
function progress(spec, opts = {}, theme) {
  const { t, s } = ctx(theme);
  const width = opts.width || 80;
  const elapsed = spec.startedAt ? (Date.now() - spec.startedAt) / 1000 : (spec.elapsed || 0);
  const parts = [];
  parts.push(t.paint(s.running, "semantic.accent", { bold: true }) + " " + t.paint(spec.label || "working", "text.primary"));
  if (spec.total) {
    const pct = Math.min(100, Math.round((spec.done / spec.total) * 100));
    const slots = 20;
    const filled = Math.round((pct / 100) * slots);
    const bar = t.paint(s.meterFull.repeat(filled), "semantic.accent") + t.paint(s.meterEmpty.repeat(slots - filled), "role.rule");
    parts.push("[" + bar + "] " + pct + "%");
    parts.push(t.paint(spec.done + "/" + spec.total, "role.system"));
    // Projection only when we have real throughput (never a fake bar — UI-006).
    if (spec.done > 0 && elapsed > 0) {
      const rate = spec.done / elapsed;
      const remain = Math.max(0, Math.round((spec.total - spec.done) / rate));
      parts.push(t.paint("~" + remain + "s left", "role.system"));
    }
  }
  parts.push(t.paint(elapsed.toFixed(1) + "s", "role.system"));
  return parts.join(" ");
}

// Multi-agent parallel tracks (UI-006). Each line is attributed to its agent;
// `focus` dims the others so one track can be followed.
// agents: [{ id, state, line }]
function agentTracks(agents, opts = {}, theme) {
  const { t, s } = ctx(theme);
  const width = opts.width || 80;
  const labelW = Math.min(14, Math.max(...agents.map((a) => stringWidth(a.id)), 4));
  const out = [];
  out.push(box.labeledRule(t, "agents (" + agents.length + " parallel)", width));
  agents.forEach((a, idx) => {
    const g = stepGlyph(a.state, s);
    const focused = opts.focus == null || opts.focus === a.id || opts.focus === idx;
    const bar = t.paint(s.treeBar.trim() || "|", focused ? "semantic.accentAlt" : "role.rule");
    const marker = t.paint(g.sym, focused ? g.token : "text.muted", { bold: focused });
    const id = t.paint(pad(a.id, labelW), focused ? "semantic.accentAlt" : "text.muted", { bold: focused });
    const avail = Math.max(10, width - labelW - 8);
    const line = t.paint(truncate(a.line || "", avail), focused ? "text.primary" : "text.muted", { dim: !focused });
    out.push(bar + " " + marker + " " + id + " " + line);
  });
  return out.join("\n");
}

// Confirmation prompt (UI-006). A destructive prompt is visibly distinct from a
// routine one and impossible to miss in a scrolling view.
// spec: { question, detail, destructive, choices } (choices default y/n)
function confirm(spec, opts = {}, theme) {
  const { t, s } = ctx(theme);
  const width = opts.width || 80;
  const destructive = !!spec.destructive;
  const title = (destructive ? s.warn + " DESTRUCTIVE — " : s.info + " confirm — ") + spec.question;
  const bodyLines = [];
  if (spec.detail) for (const d of String(spec.detail).split("\n")) bodyLines.push(d);
  const choices = spec.choices || (destructive ? ["yes, proceed", "no, cancel"] : ["yes", "no"]);
  bodyLines.push("");
  bodyLines.push(choices.map((c, i) => t.paint("[" + (i + 1) + "] ", "semantic.accent", { bold: true }) + c).join("   "));
  return box.panel(t, bodyLines, {
    width, style: "rounded", title,
    titleToken: destructive ? "semantic.error" : "semantic.info",
    borderToken: destructive ? "semantic.error" : "semantic.accent",
  });
}

// The interrupt affordance — always visible (UI-006). A quiet, persistent hint.
function interruptHint(opts = {}, theme) {
  const { t, s } = ctx(theme);
  return t.paint(s.interrupt + " esc to interrupt", "role.system");
}

module.exports = { plan, progress, agentTracks, confirm, interruptHint, stepGlyph };
