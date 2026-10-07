"use strict";
// ===================== Refactor — Plan / apply / verify =====================
// Every refactoring produces a RefactorPlan: a safety verdict plus the full new
// content for each touched file. This module turns a plan into real, atomic,
// reversible changes via the patch Transaction engine, and offers the three modes
// every refactoring shares:
//   * preview  — unified diffs, nothing written
//   * apply    — atomic commit across all files (checkpoint rollback on write error)
//   * applyVerify — apply, run a verify command/fn, auto-revert if it fails
// No silent partial changes: an unsafe plan refuses up front.

const transaction = require("../patch/transaction");
const verify = require("../patch/verify");
const diff = require("../patch/diff");
const path = require("path");

/**
 * @typedef {object} RefactorPlan
 * @property {string} refactoring   - e.g. "rename"
 * @property {boolean} ok           - safe + computed
 * @property {{safe:boolean, reasons:string[], warnings:string[]}} safety
 * @property {Map<string,string>|Object<string,string>} edits - file -> new content
 * @property {Object} [details]     - refactoring-specific summary
 */

/** Normalize plan.edits (Map or object) to an array of {file, content}. */
function editList(plan) {
  const edits = plan.edits || {};
  if (edits instanceof Map) return [...edits.entries()].map(([file, content]) => ({ file, content }));
  return Object.keys(edits).map((file) => ({ file, content: edits[file] }));
}

/** Build a staged (uncommitted) Transaction from a plan. */
function toTransaction(plan, opts) {
  opts = opts || {};
  const tx = transaction.begin({ cwd: opts.cwd });
  for (const { file, content } of editList(plan)) {
    if (content === null) tx.stageDelete(file);
    else tx.stageWrite(file, content);
  }
  return tx;
}

/**
 * Unified-diff preview of a plan. When the plan's edits carry the ORIGINAL sources
 * (plan.before map), diffs are computed in-memory and no disk read is needed;
 * otherwise the Transaction reads current file contents from disk.
 * @returns {{ok:boolean, refactoring:string, safety:object, files:Array, details:object}}
 */
function preview(plan, opts) {
  opts = opts || {};
  if (!plan.ok) {
    return { ok: false, refactoring: plan.refactoring, safety: plan.safety, files: [], details: plan.details || {} };
  }
  const before = plan.before instanceof Map ? plan.before : new Map(Object.entries(plan.before || {}));
  const files = [];
  if (before.size) {
    for (const { file, content } of editList(plan)) {
      const old = before.has(file) ? before.get(file) : "";
      if (content === null) {
        files.push({ file, action: "delete", diff: diff.createUnifiedDiff(old, "", { oldPath: file, newPath: "/dev/null" }), additions: 0, deletions: diff.splitLines(old).lines.length });
        continue;
      }
      const d = diff.createUnifiedDiff(old, content, { oldPath: old === "" ? "/dev/null" : file, newPath: file });
      const stat = diff.diffStat(d);
      files.push({ file, action: old === "" ? "create" : "modify", diff: d, additions: stat.additions, deletions: stat.deletions });
    }
    return { ok: true, refactoring: plan.refactoring, safety: plan.safety, files, details: plan.details || {} };
  }
  const tx = toTransaction(plan, opts);
  const pv = tx.preview();
  return { ok: pv.ok, refactoring: plan.refactoring, safety: plan.safety, files: pv.files, errors: pv.errors, details: plan.details || {} };
}

/**
 * Apply a plan atomically. Refuses an unsafe plan. On any write error the whole
 * change set rolls back to its checkpoint.
 * @returns {{ok:boolean, committed:boolean, ...}}
 */
function apply(plan, opts) {
  opts = opts || {};
  if (!plan.ok) {
    return { ok: false, committed: false, refused: true, safety: plan.safety };
  }
  if (opts.dryRun) {
    return { ok: true, committed: false, dryRun: true, preview: preview(plan, opts) };
  }
  const tx = toTransaction(plan, opts);
  const res = tx.commit();
  res.refactoring = plan.refactoring;
  res.details = plan.details || {};
  return res;
}

/**
 * Apply a plan, run a verification command/function, and auto-revert if it fails.
 * @param {RefactorPlan} plan
 * @param {string|function} verifier - shell command or () => boolean|{passed}
 * @param {object} [opts] - { cwd, onDirty, timeout, dryRun }
 */
function applyVerify(plan, verifier, opts) {
  opts = opts || {};
  if (!plan.ok) {
    return { ok: false, phase: "precheck", refused: true, safety: plan.safety };
  }
  const tx = toTransaction(plan, { cwd: opts.cwd });
  return verify.applyVerifyRevert({ transaction: tx, verify: verifier, opts });
}

/** Convenience: a safety verdict object. */
function safety(safe, reasons, warnings) {
  return { safe: !!safe, reasons: reasons || [], warnings: warnings || [] };
}

/** An unsafe/refused plan with reasons. */
function refuse(refactoring, reasons, warnings) {
  return { refactoring, ok: false, safety: safety(false, reasons, warnings), edits: {}, before: {} };
}

module.exports = { editList, toTransaction, preview, apply, applyVerify, safety, refuse };
