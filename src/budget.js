"use strict";
// ================= NX-102 Budget Enforcer =================
// Hard ceilings on a run, enforced HERE (by the executor) rather than by
// convention. Self-eval retry, multi-agent fan-out/debate/pipeline, and the
// autonomous /loop all multiply spend; retry multiplies it on runs already
// failing. A budget caps tokens, dollars, wall-clock, and step count, per-run and
// (via a shared parent) per-project.
//
// Contract:
//   - check BEFORE a step with canProceed(estTokens, estUSD): if the step would
//     cross a ceiling, the run STOPS and reports — it does not finish at any cost
//     and does not silently truncate.
//   - charge AFTER a step with charge({tokens, usd}); charge also stops if a
//     ceiling has been reached.
//   - predictRange() gives a shown-and-confirmable cost range BEFORE a multi-agent
//     or loop op begins.
//   - retryDecision() bounds retries and flags a retry that costs more than the
//     first attempt saved as a LOSS.

const { priceOf } = require("./pricing");

const DEFAULTS = {
  maxTokens: 500000,   // input+output tokens for the whole run
  maxUSD: 5,           // dollars (API billing); informational on subscription/free
  maxWallMs: 10 * 60 * 1000, // 10 minutes
  maxSteps: 50,        // agent steps / turns
  warnAt: 0.8,         // warn at 80% of any ceiling
};

function createBudget(limits, parent) {
  const l = Object.assign({}, DEFAULTS, limits || {});
  return {
    limits: l,
    parent: parent || null, // optional per-project budget this run also draws from
    spent: { tokens: 0, usd: 0, steps: 0 },
    startedAt: Date.now(),
    stopped: false,
    stopReason: null,
    events: [],

    _elapsed() { return Date.now() - this.startedAt; },

    // Which ceiling (if any) a hypothetical total would cross. Returns null if clear.
    _breach(tokens, usd, steps) {
      if (tokens > l.maxTokens) return { ceiling: "tokens", limit: l.maxTokens, value: tokens };
      if (usd > l.maxUSD) return { ceiling: "usd", limit: l.maxUSD, value: usd };
      if (steps > l.maxSteps) return { ceiling: "steps", limit: l.maxSteps, value: steps };
      if (this._elapsed() > l.maxWallMs) return { ceiling: "wallClock", limit: l.maxWallMs, value: this._elapsed() };
      return null;
    },

    // Fraction (0..1) of the most-consumed ceiling.
    pctUsed() {
      return Math.max(
        this.spent.tokens / l.maxTokens,
        this.spent.usd / l.maxUSD,
        this.spent.steps / l.maxSteps,
        this._elapsed() / l.maxWallMs
      );
    },

    // Call BEFORE a step. Does the predicted next step fit? If not, stop+report.
    canProceed(estTokens, estUSD) {
      if (this.stopped) return { ok: false, stop: true, reason: this.stopReason };
      const t = this.spent.tokens + (estTokens || 0);
      const u = this.spent.usd + (estUSD || 0);
      const s = this.spent.steps + 1;
      // also fold in the parent per-project budget if present
      if (this.parent) {
        const pb = this.parent._breach(this.parent.spent.tokens + (estTokens || 0),
          this.parent.spent.usd + (estUSD || 0), this.parent.spent.steps + 1);
        if (pb) { this._stop("per-project budget would be exceeded: " + pb.ceiling); return { ok: false, stop: true, reason: this.stopReason, breach: pb, scope: "project" }; }
      }
      const b = this._breach(t, u, s);
      if (b) {
        this._stop("would exceed " + b.ceiling + " ceiling (" + b.value + " > " + b.limit + ")");
        return { ok: false, stop: true, reason: this.stopReason, breach: b, scope: "run" };
      }
      const warn = this.pctUsed() >= l.warnAt;
      return { ok: true, stop: false, warn, pctUsed: +this.pctUsed().toFixed(3) };
    },

    // Call AFTER a step with its real cost. Stops if a ceiling has now been reached.
    charge(delta) {
      delta = delta || {};
      this.spent.tokens += delta.tokens || 0;
      this.spent.usd += delta.usd || 0;
      this.spent.steps += 1;
      if (this.parent) {
        this.parent.spent.tokens += delta.tokens || 0;
        this.parent.spent.usd += delta.usd || 0;
        this.parent.spent.steps += 1;
      }
      this.events.push({ at: Date.now(), tokens: delta.tokens || 0, usd: delta.usd || 0, label: delta.label || "" });
      const b = this._breach(this.spent.tokens, this.spent.usd, this.spent.steps);
      if (b) this._stop("reached " + b.ceiling + " ceiling");
      return { stopped: this.stopped, reason: this.stopReason, pctUsed: +this.pctUsed().toFixed(3), spent: Object.assign({}, this.spent) };
    },

    _stop(reason) { this.stopped = true; this.stopReason = reason; },

    snapshot() {
      return {
        spent: Object.assign({ wallMs: this._elapsed() }, this.spent),
        limits: l,
        pctUsed: +this.pctUsed().toFixed(3),
        stopped: this.stopped,
        stopReason: this.stopReason,
        remaining: {
          tokens: Math.max(0, l.maxTokens - this.spent.tokens),
          usd: +Math.max(0, l.maxUSD - this.spent.usd).toFixed(4),
          steps: Math.max(0, l.maxSteps - this.spent.steps),
          wallMs: Math.max(0, l.maxWallMs - this._elapsed()),
        },
      };
    },
  };
}

// Predicted cost RANGE for a planned run, shown and confirmable BEFORE it starts.
// plan: { steps, avgInTokens, avgOutTokens, model, variance } — variance widens
// the band (default 0.5 = +/-50%). Returns token + dollar low/expected/high.
function predictRange(plan) {
  plan = plan || {};
  const steps = plan.steps || 1;
  const inTok = (plan.avgInTokens || 0) * steps;
  const outTok = (plan.avgOutTokens || 0) * steps;
  const p = priceOf(plan.model);
  const expectedTok = inTok + outTok;
  const expectedUSD = (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
  const v = plan.variance != null ? plan.variance : 0.5;
  return {
    steps,
    model: plan.model || "(default)",
    tokens: { low: Math.round(expectedTok * (1 - v)), expected: Math.round(expectedTok), high: Math.round(expectedTok * (1 + v)) },
    usd: { low: +(expectedUSD * (1 - v)).toFixed(4), expected: +expectedUSD.toFixed(4), high: +(expectedUSD * (1 + v)).toFixed(4) },
    note: "range = expected +/- " + Math.round(v * 100) + "%. Confirm before a multi-agent or loop op.",
  };
}

// Bounded retry policy. A retry is only worth it if its expected cost is less than
// the value of the quality it is expected to recover. We make the economics
// explicit: a retry that costs MORE than the first attempt saved is a LOSS.
// args: { attempt, maxAttempts, quality, threshold, firstAttemptCost, retryCost }
function retryDecision(args) {
  args = args || {};
  const attempt = args.attempt || 1;
  const maxAttempts = args.maxAttempts != null ? args.maxAttempts : 1; // default: no retry
  const quality = args.quality != null ? args.quality : 1;
  const threshold = args.threshold != null ? args.threshold : 0.7;

  if (quality >= threshold) return { retry: false, reason: "quality " + quality + " >= threshold " + threshold };
  if (attempt >= maxAttempts) return { retry: false, reason: "retry budget exhausted (" + attempt + "/" + maxAttempts + ")" };

  const firstCost = args.firstAttemptCost || 0;
  const retryCost = args.retryCost != null ? args.retryCost : firstCost;
  // If the retry costs more than the first attempt itself cost, and we are not
  // confident of a large quality gain, flag the economic loss explicitly.
  const loss = retryCost > firstCost;
  return {
    retry: true,
    attempt: attempt + 1,
    reason: "quality " + quality + " < threshold " + threshold,
    economicWarning: loss ? ("retry cost " + retryCost + " exceeds first-attempt cost " + firstCost + " — report as a loss if quality does not clear the threshold") : null,
  };
}

// Multi-agent fan-out must be OPT-IN per invocation (never the default for an
// ordinary task). This gate makes that explicit.
function fanOutAllowed(opts) {
  opts = opts || {};
  if (opts.fanOut === true) return { allowed: true, reason: "explicit per-invocation opt-in" };
  if (opts.standingPreference === "fanOut") return { allowed: true, reason: "stated standing preference" };
  return { allowed: false, reason: "fan-out not opted in — a single agent is the default for an ordinary task" };
}

module.exports = { DEFAULTS, createBudget, predictRange, retryDecision, fanOutAllowed };
