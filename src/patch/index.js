"use strict";
// ================= Nexus Patch / Codemod Engine — public entrypoint =================
// The underlying engine by which Nexus edits code reliably and reversibly.
//
//   diff        — line diff (Myers), unified-diff generate + parse, diff stats
//   apply       — fuzzy hunk apply with drift tolerance and clean rejection
//   transaction — stage edits across files; commit atomically or roll back fully
//   codemod     — identifier-aware scoped transforms (rename, wrap calls, replace)
//   verify      — apply -> run verify command -> auto-revert on failure
//   preview     — dry-run renderings for all of the above
//
// Safety guarantees (see README.md for the full contract):
//   * No silent half-apply: a rejected hunk aborts the file apply by default.
//   * Atomic multi-file commits: all files change or none do.
//   * Reversible: every mutation can be undone from a checkpoint.
//   * Dirty-tree aware: the verify harness refuses (or snapshots) a dirty tree.
//
// Zero third-party dependencies — Node.js stdlib only.

const diff = require("./diff");
const apply = require("./apply");
const transaction = require("./transaction");
const codemod = require("./codemod");
const verify = require("./verify");
const preview = require("./preview");

/**
 * High-level convenience: apply a raw unified diff to a single file on disk,
 * atomically and reversibly, with optional dry-run.
 * @param {string} file - path to the target file
 * @param {string} unifiedDiff - unified diff text
 * @param {object} [opts] - { cwd, dryRun, fuzz, maxOffset }
 * @returns {object} commit result (or dry-run preview)
 */
function applyDiffToFile(file, unifiedDiff, opts) {
  opts = opts || {};
  const parsed = diff.parseUnifiedDiff(unifiedDiff);
  if (parsed.length === 0) return { ok: false, reason: "no hunks in diff" };
  const tx = transaction.begin({ cwd: opts.cwd });
  tx.stagePatch(file, parsed[0], { fuzz: opts.fuzz, maxOffset: opts.maxOffset });
  return tx.commit({ dryRun: opts.dryRun });
}

module.exports = {
  diff,
  apply,
  transaction,
  codemod,
  verify,
  preview,
  // flattened conveniences
  createUnifiedDiff: diff.createUnifiedDiff,
  parseUnifiedDiff: diff.parseUnifiedDiff,
  applyPatch: apply.applyPatch,
  applyUnifiedDiff: apply.applyUnifiedDiff,
  begin: transaction.begin,
  Transaction: transaction.Transaction,
  applyVerifyRevert: verify.applyVerifyRevert,
  applyDiffToFile,
};
