"use strict";
// ================= NX-108 Loop Detection =================
// "Stuck in loops" is a product-specific reliability defect: the agent repeats
// the same step, makes no progress against the goal, or oscillates between two
// edits forever, burning tokens. This guard watches the step stream and STOPS +
// REPORTS when it detects one of three failure shapes:
//   1. identical/near-identical step repeating,
//   2. no progress against the goal over a window,
//   3. oscillating edits (A -> B -> A -> B ...).
// Pure and deterministic: feed it steps, read .check().

const crypto = require("crypto");

function sig(step) {
  // A step's identity: action + target + a hash of its output. Near-identical
  // outputs collapse via normalization (whitespace + case) before hashing.
  const action = String(step.action || "").toLowerCase().trim();
  const target = String(step.target || "").toLowerCase().trim();
  const outNorm = String(step.output || "").toLowerCase().replace(/\s+/g, " ").trim();
  const outHash = crypto.createHash("sha1").update(outNorm).digest("hex").slice(0, 12);
  return action + "|" + target + "|" + outHash;
}

function createLoopGuard(opts) {
  opts = opts || {};
  const maxRepeats = opts.maxRepeats || 3;       // identical step N times => loop
  const noProgressWindow = opts.noProgressWindow || 4; // steps with no progress => stuck
  const window = opts.window || 12;              // how many recent steps to keep

  const steps = [];
  return {
    steps,
    // Record a step; returns the current status (stop + reason when a loop is found).
    record(step) {
      const s = { sig: sig(step), progress: step.progress !== false, raw: step, at: Date.now() };
      steps.push(s);
      if (steps.length > window) steps.shift();
      return this.check();
    },
    check() {
      if (steps.length < 2) return { stop: false, reason: "ok" };

      // 1. identical/near-identical repetition
      const counts = {};
      for (const s of steps) counts[s.sig] = (counts[s.sig] || 0) + 1;
      for (const [k, n] of Object.entries(counts)) {
        if (n >= maxRepeats) return { stop: true, pattern: "identical-repeat", reason: "step repeated " + n + " times (>= " + maxRepeats + "): " + k.slice(0, 40), repeats: n };
      }

      // 2. oscillation A,B,A,B (two distinct sigs alternating for >= 2 full cycles)
      if (steps.length >= 4) {
        const tail = steps.slice(-4).map(s => s.sig);
        if (tail[0] !== tail[1] && tail[0] === tail[2] && tail[1] === tail[3]) {
          return { stop: true, pattern: "oscillation", reason: "oscillating between two steps (A,B,A,B)" };
        }
      }

      // 3. no progress across a window
      if (steps.length >= noProgressWindow) {
        const recent = steps.slice(-noProgressWindow);
        if (recent.every(s => !s.progress)) {
          return { stop: true, pattern: "no-progress", reason: "no progress in the last " + noProgressWindow + " steps" };
        }
      }

      return { stop: false, reason: "ok" };
    },
    reset() { steps.length = 0; },
  };
}

module.exports = { createLoopGuard, sig };
