"use strict";
// ================= NX-104 Steerability — interruption as a first-class state =================
// The rising "lack of control" complaint is that agents understand, proceed, and
// cannot be stopped/inspected/reined in mid-run. This module makes interruption a
// first-class run state (pause / inspect / redirect / resume / kill) with a plan
// that is visible and editable before and during execution, and a clean kill that
// leaves the tree in a KNOWN state.
//
// It also declares, per mutation class, how a change is rolled back, so /undo
// coverage is explicit rather than assumed. File edits and codemods use the
// time-travel snapshot; git and dependency ops capture pre-op state; plugin/MCP
// actions have external side effects and are gated (confirm-before), not
// auto-rolled-back.

const STATES = ["planning", "running", "paused", "redirecting", "killed", "done"];

// Which mutation classes /undo actually covers, and how.
const MUTATION_CLASSES = {
  "file-edit":  { reversible: true,      via: "time-travel content snapshot", needsConfirm: false },
  "codemod":    { reversible: true,      via: "time-travel content snapshot (per touched file)", needsConfirm: false },
  "git":        { reversible: "partial", via: "capture HEAD + stash dirty before op; reset/revert to captured ref", needsConfirm: true },
  "dependency": { reversible: true,      via: "snapshot manifest + lockfile before op; reinstall to restore", needsConfirm: true },
  "plugin":     { reversible: false,     via: "external side effects — confirm before; cannot auto-rollback", needsConfirm: true },
  "mcp":        { reversible: false,     via: "external side effects — confirm before; cannot auto-rollback", needsConfirm: true },
};

// Policy for a mutation about to be applied: does it need a checkpoint first, a
// confirmation, and is it reversible at all?
function checkpointPolicy(mutationClass) {
  const m = MUTATION_CLASSES[mutationClass];
  if (!m) return { known: false, needsCheckpoint: true, needsConfirm: true, reversible: false, reason: "unknown mutation class — treat as irreversible" };
  return {
    known: true,
    reversible: m.reversible,
    needsCheckpoint: m.reversible !== false, // checkpoint anything we can roll back
    needsConfirm: m.needsConfirm,
    via: m.via,
  };
}

// ---- Run state machine ----
function createRun(plan) {
  return {
    state: "planning",
    plan: (plan || []).map((p, i) => ({ n: i, label: typeof p === "string" ? p : p.label, status: "pending", scope: (p && p.scope) || null })),
    cursor: 0,
    history: [],
    _log(ev) { this.history.push(Object.assign({ at: Date.now(), from: this.state }, ev)); },

    start() {
      if (this.state !== "planning" && this.state !== "paused") return this._deny("start", "can only start from planning/paused");
      this._log({ op: "start" }); this.state = "running"; return this.ok();
    },
    // Interruption: pause mid-run without losing context.
    pause() {
      if (this.state !== "running") return this._deny("pause", "not running");
      this._log({ op: "pause" }); this.state = "paused"; return this.ok();
    },
    resume() {
      if (this.state !== "paused" && this.state !== "redirecting") return this._deny("resume", "not paused");
      this._log({ op: "resume", cursor: this.cursor }); this.state = "running"; return this.ok();
    },
    // Inspect: non-mutating snapshot available in any state.
    inspect() {
      return { state: this.state, cursor: this.cursor, plan: this.plan, done: this.plan.filter(s => s.status === "done").length, total: this.plan.length };
    },
    // Redirect: change course mid-run while keeping context. Enters a transient
    // "redirecting" state; caller edits the plan then resume()s.
    redirect(note) {
      if (this.state !== "paused" && this.state !== "running") return this._deny("redirect", "must be running or paused");
      this._log({ op: "redirect", note: note || "" }); this.state = "redirecting"; return this.ok();
    },
    // Clean kill: leaves the tree in a KNOWN state. Steps not yet started are
    // cancelled; a step mid-flight is marked for rollback by the caller.
    kill(reason) {
      this._log({ op: "kill", reason: reason || "" });
      for (const s of this.plan) if (s.status === "pending") s.status = "cancelled";
      const inFlight = this.plan.find(s => s.status === "running");
      this.state = "killed";
      return { ok: true, state: "killed", needsRollback: inFlight ? inFlight.n : null, reason: reason || "" };
    },

    // ---- plan editing (before or during execution) ----
    strike(n) { const s = this.plan.find(x => x.n === n); if (!s || s.status === "done") return this._deny("strike", "no such pending step"); s.status = "struck"; this._log({ op: "strike", n }); return this.ok(); },
    reorder(order) {
      if (!Array.isArray(order)) return this._deny("reorder", "order must be an array of step ns");
      const map = new Map(this.plan.map(s => [s.n, s]));
      const next = order.map(n => map.get(n)).filter(Boolean);
      if (next.length !== this.plan.length) return this._deny("reorder", "order must reference every step exactly once");
      this.plan = next; this._log({ op: "reorder", order }); return this.ok();
    },
    constrainScope(n, scope) { const s = this.plan.find(x => x.n === n); if (!s) return this._deny("constrainScope", "no such step"); s.scope = scope; this._log({ op: "constrainScope", n, scope }); return this.ok(); },

    // advance the cursor over struck/cancelled steps
    next() {
      while (this.cursor < this.plan.length && this.plan[this.cursor].status !== "pending") this.cursor++;
      const s = this.plan[this.cursor];
      if (!s) { this.state = "done"; return { done: true }; }
      s.status = "running";
      return { step: s };
    },
    complete(n) { const s = this.plan.find(x => x.n === n); if (s) s.status = "done"; if (this.cursor < this.plan.length) this.cursor++; return this.ok(); },

    ok() { return { ok: true, state: this.state }; },
    _deny(op, why) { this._log({ op: op + ":denied", why }); return { ok: false, state: this.state, reason: why }; },
  };
}

module.exports = { STATES, MUTATION_CLASSES, checkpointPolicy, createRun };
