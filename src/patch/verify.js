"use strict";
// ================= Apply -> verify -> auto-revert harness =================
// Applies a staged change set, runs a verification command (tests, build, lint),
// and automatically rolls the change set back if verification fails. The working
// set is snapshotted before the change, so a revert restores it byte-for-byte.
//
// Dirty-tree safety: by default the harness REFUSES to run against a git working
// tree that already has uncommitted changes touching the target files, so a failed
// verify cannot clobber unrelated edits. Callers may opt into deterministic
// snapshot-based isolation instead of refusing.

const { execSync } = require("child_process");
const path = require("path");
const transaction = require("./transaction");

/**
 * Inspect a git working tree (if any) for uncommitted changes.
 * @param {string} cwd
 * @returns {{isGit: boolean, dirty: boolean, files: string[]}}
 */
function gitStatus(cwd) {
  try {
    const out = execSync("git status --porcelain", {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const files = out.split("\n").map(l => l.slice(3).trim()).filter(Boolean);
    return { isGit: true, dirty: files.length > 0, files };
  } catch (_) {
    return { isGit: false, dirty: false, files: [] };
  }
}

/**
 * Are any of `touched` already modified in the working tree?
 * @param {string} cwd
 * @param {string[]} touched - absolute paths
 * @returns {{conflict: boolean, files: string[], status: object}}
 */
function dirtyConflict(cwd, touched) {
  const status = gitStatus(cwd);
  if (!status.isGit || !status.dirty) return { conflict: false, files: [], status };
  const dirtyAbs = new Set(status.files.map(f => path.resolve(cwd, f)));
  const hits = touched.filter(t => dirtyAbs.has(path.resolve(t)));
  return { conflict: hits.length > 0, files: hits, status };
}

/**
 * Run a verification command, returning a structured result (never throws).
 * @param {string} command
 * @param {object} [opts] - { cwd, timeout, env }
 * @returns {{passed: boolean, exitCode: number, stdout: string, stderr: string, duration: number}}
 */
function runVerify(command, opts) {
  opts = opts || {};
  const start = Date.now();
  try {
    const stdout = execSync(command, {
      cwd: opts.cwd || process.cwd(),
      timeout: opts.timeout || 120000,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { passed: true, exitCode: 0, stdout, stderr: "", duration: Date.now() - start };
  } catch (e) {
    return {
      passed: false,
      exitCode: e.status == null ? 1 : e.status,
      stdout: String(e.stdout || ""),
      stderr: String(e.stderr || e.message || ""),
      duration: Date.now() - start,
    };
  }
}

/**
 * Apply a transaction, verify it, and auto-revert on failure.
 * @param {object} args
 * @param {transaction.Transaction} args.transaction - the staged change set
 * @param {string|function} args.verify - a shell command, or a () => boolean|{passed}
 * @param {object} [args.opts]
 * @param {string} [args.opts.cwd=process.cwd()]
 * @param {"refuse"|"snapshot"} [args.opts.onDirty="refuse"] - dirty-tree policy
 * @param {number} [args.opts.timeout] - verify command timeout (ms)
 * @param {boolean} [args.opts.dryRun=false]
 * @returns {{ok: boolean, phase: string, verified?: boolean, reverted?: boolean, ...}}
 */
function applyVerifyRevert(args) {
  const tx = args.transaction;
  const opts = args.opts || {};
  const cwd = opts.cwd || tx.cwd || process.cwd();
  const touched = tx.touched();

  // Dry run: show what would happen, touch nothing, run nothing.
  if (opts.dryRun) {
    return { ok: true, phase: "dry-run", preview: tx.preview() };
  }

  // Dirty-tree guard.
  const onDirty = opts.onDirty || "refuse";
  const conflict = dirtyConflict(cwd, touched);
  if (conflict.conflict && onDirty === "refuse") {
    return {
      ok: false,
      phase: "precheck",
      reason: "dirty-tree",
      message: "Refusing: target files have uncommitted changes. Commit/stash them or use onDirty:'snapshot'.",
      dirtyFiles: conflict.files,
    };
  }
  // In 'snapshot' mode we rely on our own checkpoint (taken below) for isolation,
  // which is deterministic and does not depend on git.

  // Validate before writing anything.
  const planned = tx.plan();
  if (!planned.ok) {
    return { ok: false, phase: "plan", reason: "invalid-changeset", errors: planned.errors };
  }

  // Snapshot -> apply.
  const cp = transaction.checkpoint(touched);
  const commit = tx.commit();
  if (!commit.ok) {
    return { ok: false, phase: "apply", reason: "commit-failed", detail: commit };
  }

  // Verify.
  let result;
  if (typeof args.verify === "function") {
    let r;
    try { r = args.verify(); } catch (e) { r = { passed: false, stderr: e.message }; }
    result = typeof r === "boolean" ? { passed: r, exitCode: r ? 0 : 1, stdout: "", stderr: "", duration: 0 } : r;
  } else {
    result = runVerify(args.verify, { cwd, timeout: opts.timeout });
  }

  if (result.passed) {
    return { ok: true, phase: "done", verified: true, reverted: false, written: commit.written, verify: result };
  }

  // Verification failed -> auto-revert to the pre-change snapshot.
  const rollbackActions = transaction.restore(cp);
  return {
    ok: false,
    phase: "verify",
    verified: false,
    reverted: true,
    verify: result,
    rollbackActions,
  };
}

module.exports = { gitStatus, dirtyConflict, runVerify, applyVerifyRevert };
