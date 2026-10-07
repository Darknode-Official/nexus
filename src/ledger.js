"use strict";
// ================= NX-103 Cost Ledger — where the money went =================
// Extends the live cost meter + telemetry into an AUDITABLE record. From the
// post-run ledger alone a user can reconstruct the full cost of a run and
// attribute every token to a subsystem.
//
// Live (during the run):  which engine/model handles the current step and WHY,
//                         tokens so far, projected total, plan position.
// After (post-run):       a per-step ledger (model, tokens in/out, cost, duration,
//                         cache hits, subsystem contribution) + cowork delegation
//                         trace + flagged defects.
//
// Two defects are first-class here:
//   - SILENT ESCALATION: engine/model/billing path changes without the user's
//     knowledge. Escalating to a PAID path silently is data-loss severity.
//   - SAVINGS ERASURE: a strong model rewrites a cheap model's valid output on
//     style grounds, erasing the delegation saving.

const { costOf, detectBilling } = require("./pricing");

// Known subsystem token sources (for attribution). Free-form strings also allowed.
const SUBSYSTEMS = ["user", "context-engine", "knowledge-graph", "prompt-template", "cot", "mcp-tools", "session-resume", "self-eval", "output", "autocorrect-saving"];

function createLedger(opts) {
  opts = opts || {};
  return {
    startedAt: Date.now(),
    plan: opts.plan || [],         // array of planned step labels, for "plan position"
    steps: [],
    delegations: [],
    defects: [],                   // flagged escalations / savings erasure / etc.
    _lastPath: null,               // { engine, model, billing } of the previous step

    // Record one step. `subsystems` maps subsystem -> tokens it contributed (in+out).
    step(rec) {
      rec = rec || {};
      const inTok = rec.tokensIn || 0, outTok = rec.tokensOut || 0;
      const cost = rec.cost != null ? rec.cost : costOf(inTok, outTok, rec.model);
      const billing = rec.billing || detectBilling(rec.engine, rec.model).type;

      // Silent-escalation detection: did engine/model/billing change without a
      // user-initiated switch?
      if (this._lastPath && !rec.userInitiatedSwitch) {
        const changed = this._lastPath.engine !== rec.engine || this._lastPath.model !== rec.model || this._lastPath.billing !== billing;
        if (changed) {
          const toPaid = this._lastPath.billing !== "api" && billing === "api";
          this.defects.push({
            kind: "silent-escalation",
            severity: toPaid ? "data-loss" : "warning",
            from: this._lastPath,
            to: { engine: rec.engine, model: rec.model, billing },
            reason: toPaid ? "escalated to a PAID per-token path without the user's knowledge" : "engine/model changed without a user-initiated switch",
            step: this.steps.length,
          });
        }
      }

      const step = {
        n: this.steps.length,
        planPosition: rec.planPosition != null ? rec.planPosition : this.steps.length,
        engine: rec.engine || "",
        model: rec.model || "",
        billing,
        why: rec.why || "",
        tokensIn: inTok,
        tokensOut: outTok,
        cost: +cost.toFixed(6),
        durationMs: rec.durationMs || 0,
        cacheHit: !!rec.cacheHit,
        subsystems: rec.subsystems || {},
      };
      this.steps.push(step);
      this._lastPath = { engine: step.engine, model: step.model, billing };
      return step;
    },

    // Record a cowork delegation. If a strong model rewrote a cheap model's valid
    // output on style grounds, the saving was erased — flag it.
    delegation(d) {
      d = d || {};
      const rec = {
        task: d.task || "",
        from: d.from || "",       // cheap model that produced valid output
        to: d.to || "",           // strong model
        saved: d.saved || 0,      // dollars the delegation was supposed to save
        rewroteValidOutput: !!d.rewroteValidOutput,
        reason: d.reason || "",
      };
      this.delegations.push(rec);
      if (rec.rewroteValidOutput) {
        this.defects.push({
          kind: "savings-erased",
          severity: "warning",
          reason: "strong model '" + rec.to + "' rewrote valid output from cheap model '" + rec.from + "' — delegation saving of $" + rec.saved + " erased",
          task: rec.task,
        });
      }
      return rec;
    },

    // LIVE snapshot: what is happening right now + projection.
    live(current) {
      current = current || {};
      const spentTokens = this.steps.reduce((s, x) => s + x.tokensIn + x.tokensOut, 0);
      const spentCost = this.steps.reduce((s, x) => s + x.cost, 0);
      const done = this.steps.length;
      const planned = this.plan.length || null;
      const avgPerStep = done ? spentCost / done : 0;
      const projTotal = planned ? spentCost + avgPerStep * Math.max(0, planned - done) : null;
      return {
        currentEngine: current.engine || (this._lastPath && this._lastPath.engine) || "",
        currentModel: current.model || (this._lastPath && this._lastPath.model) || "",
        why: current.why || "",
        planPosition: planned ? done + "/" + planned : String(done),
        tokensSoFar: spentTokens,
        costSoFar: +spentCost.toFixed(4),
        projectedTotalCost: projTotal != null ? +projTotal.toFixed(4) : null,
        defectsSoFar: this.defects.length,
      };
    },

    // POST-RUN: full reconstruction. Every token attributed to a subsystem.
    reconstruct() {
      const bySubsystem = {};
      let totalTokens = 0, totalCost = 0, cacheHits = 0;
      for (const s of this.steps) {
        totalTokens += s.tokensIn + s.tokensOut;
        totalCost += s.cost;
        if (s.cacheHit) cacheHits++;
        for (const [sys, tok] of Object.entries(s.subsystems)) {
          bySubsystem[sys] = (bySubsystem[sys] || 0) + tok;
        }
      }
      // Attribution completeness: do the subsystem tallies cover all tokens?
      const attributed = Object.values(bySubsystem).reduce((a, b) => a + b, 0);
      const unattributed = totalTokens - attributed;
      return {
        steps: this.steps,
        totalSteps: this.steps.length,
        totalTokens,
        totalCost: +totalCost.toFixed(6),
        cacheHits,
        bySubsystem,
        unattributedTokens: unattributed,
        attributionComplete: unattributed === 0,
        delegations: this.delegations,
        defects: this.defects,
        durationMs: Date.now() - this.startedAt,
      };
    },

    // Human-readable post-run ledger.
    text() {
      const r = this.reconstruct();
      const lines = ["=== Nexus Cost Ledger ===", "steps: " + r.totalSteps + "  tokens: " + r.totalTokens + "  cost: $" + r.totalCost.toFixed(4) + "  cache hits: " + r.cacheHits];
      lines.push("", "Per-step:");
      for (const s of r.steps) lines.push("  #" + s.n + " " + (s.engine || "?") + "/" + (s.model || "?") + " " + s.tokensIn + "in/" + s.tokensOut + "out $" + s.cost.toFixed(4) + (s.cacheHit ? " [cache]" : "") + (s.why ? " — " + s.why : ""));
      lines.push("", "By subsystem:");
      for (const [sys, tok] of Object.entries(r.bySubsystem).sort((a, b) => b[1] - a[1])) lines.push("  " + sys + ": " + tok + " tokens");
      if (r.unattributedTokens) lines.push("  (unattributed: " + r.unattributedTokens + " tokens)");
      if (r.defects.length) { lines.push("", "DEFECTS:"); for (const d of r.defects) lines.push("  [" + d.severity + "] " + d.kind + ": " + d.reason); }
      return lines.join("\n");
    },
  };
}

module.exports = { createLedger, SUBSYSTEMS };
