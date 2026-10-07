"use strict";
// ============================= Shellplan — guarded safe-run wrapper =============================
// A thin executor for commands that shellplan classifies at or below a caller-set
// risk threshold. It REFUSES anything above the threshold and never runs a command
// the risk engine flags as destructive by default. It is a convenience for the
// "obviously safe" case (ls, git status, cat a project file); anything riskier must
// go through the real enforcement path (../capability.js + ../sandbox.js) with an
// explicit human/policy decision.
//
// Guarantees:
//   - classifies first; refuses when maxSeverity > threshold
//   - optionally checks a sandbox-style policy via plan.wouldSandboxAllow
//   - timeout + captured stdout/stderr + chosen cwd/env
//   - dryRun mode returns the plan WITHOUT spawning anything

const { spawn } = require("child_process");
const { classify, severityRank } = require("./risk");
const { wouldSandboxAllow, dryRun } = require("./plan");

/**
 * @typedef {Object} SafeRunOptions
 * @property {string}   [cwd]
 * @property {Object}   [env]
 * @property {number}   [timeout]        ms, default 15000
 * @property {string}   [riskThreshold]  highest severity permitted to run; default "low"
 * @property {number}   [maxOutput]      bytes captured per stream; default 1_000_000
 * @property {object}   [policy]         if given, wouldSandboxAllow must pass too
 * @property {boolean}  [dryRun]         do not execute; return the plan
 * @property {string}   [shell]          shell to use; default /bin/sh
 */

/**
 * Run a command only if it is classified safe enough.
 * @param {string} cmd
 * @param {SafeRunOptions} [opts]
 * @returns {Promise<object>} result with { ran, refused, reason, risk, ... }
 */
function safeRun(cmd, opts) {
  opts = opts || {};
  const threshold = opts.riskThreshold || "low";
  const risk = classify(cmd);

  // Gate 1: risk threshold
  if (severityRank(risk.maxSeverity) > severityRank(threshold)) {
    return Promise.resolve({
      ran: false,
      refused: true,
      reason: "risk " + risk.maxSeverity + " exceeds threshold " + threshold,
      risk,
      findings: risk.findings,
    });
  }

  // Gate 2: sandbox policy (optional)
  if (opts.policy) {
    const pred = wouldSandboxAllow(cmd, opts.policy, { cwd: opts.cwd });
    if (!pred.allowed) {
      return Promise.resolve({ ran: false, refused: true, reason: "sandbox policy would deny", risk, sandbox: pred });
    }
  }

  // Dry-run: return the plan, run nothing.
  if (opts.dryRun) {
    return Promise.resolve({ ran: false, refused: false, dryRun: true, reason: "dry run", risk, plan: dryRun(cmd, { cwd: opts.cwd }) });
  }

  return execGuarded(cmd, opts, risk);
}

function execGuarded(cmd, opts, risk) {
  const timeout = opts.timeout || 15000;
  const maxOutput = opts.maxOutput || 1000000;
  const cwd = opts.cwd || process.cwd();
  const shell = opts.shell || "/bin/sh";

  return new Promise((resolve) => {
    const start = Date.now();
    let child;
    try {
      child = spawn(shell, ["-c", cmd], {
        cwd,
        env: Object.assign({}, process.env, opts.env || {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ ran: false, refused: false, error: String(e && e.message || e), reason: "spawn failed", risk });
      return;
    }

    let out = "";
    let err = "";
    let outTrunc = false;
    let errTrunc = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch (_) {}
    }, timeout);

    child.stdout.on("data", (c) => {
      if (out.length < maxOutput) out += c.toString("utf8");
      if (out.length >= maxOutput && !outTrunc) { outTrunc = true; out = out.slice(0, maxOutput); }
    });
    child.stderr.on("data", (c) => {
      if (err.length < maxOutput) err += c.toString("utf8");
      if (err.length >= maxOutput && !errTrunc) { errTrunc = true; err = err.slice(0, maxOutput); }
    });

    function finish(exitCode, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ran: true,
        refused: false,
        reason: timedOut ? "timeout" : "completed",
        risk,
        stdout: out,
        stderr: err,
        exitCode: exitCode == null ? (signal ? 128 : null) : exitCode,
        signal: signal || null,
        timedOut,
        truncated: outTrunc || errTrunc,
        duration: Date.now() - start,
        cwd,
      });
    }

    child.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ran: false, refused: false, error: String(e && e.message || e), reason: "exec error", risk }); } });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

module.exports = {
  safeRun,
};
